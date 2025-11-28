import { useEffect, useMemo, useState } from 'react'
import type { FirebaseOptions } from 'firebase/app'
import { getApps, initializeApp } from 'firebase/app'
import { collection, doc, getDocs, getFirestore, setDoc } from 'firebase/firestore'
import {
  getAuth,
  getIdTokenResult,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth'
import { getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage'
import './App.css'

type Banner = {
  id: string
  imageUrl: string
  label: string
  url: string
}

type FormState = {
  id: string
  label: string
  url: string
  imageUrl: string
}

const demoBanners: Banner[] = [
  {
    id: 'ps5console',
    label: '🔥 PlayStation 5 Console 🔥',
    url: 'https://www.amazon.com.au/PlayStation-PS5-Disc-Console-Slim/dp/B0CN2MHCWT',
    imageUrl:
      'https://m.media-amazon.com/images/I/516yiK6U+FL._AC_UL640_FMwebp_QL65_.jpg',
  },
]

const emptyForm: FormState = {
  id: '',
  label: '',
  url: '',
  imageUrl: '',
}

const envFirebaseConfig = (() => {
  const get = (key: string) =>
    (import.meta.env as Record<string, string | undefined>)[key]

  const apiKey =
    get('VITE_FIREBASE_API_KEY') || get('EXPO_PUBLIC_FIREBASE_API_KEY') || ''
  const authDomain =
    get('VITE_FIREBASE_AUTH_DOMAIN') || get('EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN') || ''
  const projectId =
    get('VITE_FIREBASE_PROJECT_ID') || get('EXPO_PUBLIC_FIREBASE_PROJECT_ID') || ''
  const storageBucket =
    get('VITE_FIREBASE_STORAGE_BUCKET') ||
    get('EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET') ||
    ''
  const messagingSenderId =
    get('VITE_FIREBASE_MESSAGING_SENDER_ID') ||
    get('EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID') ||
    ''
  const appId = get('VITE_FIREBASE_APP_ID') || get('EXPO_PUBLIC_FIREBASE_APP_ID') || ''

  if (apiKey && projectId && storageBucket && appId) {
    return JSON.stringify(
      {
        apiKey,
        authDomain,
        projectId,
        storageBucket,
        messagingSenderId,
        appId,
      },
      null,
      2
    )
  }
  return ''
})()

const defaultFirebaseConfig =
  envFirebaseConfig ||
  `{
  "apiKey": "",
  "authDomain": "",
  "projectId": "",
  "storageBucket": "",
  "messagingSenderId": "",
  "appId": ""
}`

const clamp = (value: string, max = 140) =>
  value.length > max ? value.slice(0, max) : value

const toSlug = (value: string, max = 60) =>
  clamp(
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, ''),
    max
  ) || 'banner'

// Toggle to true to enforce admin-only access (requires custom claim role: "admin").
const ENFORCE_ADMIN_ROLE = false
// Comma-separated list of admin user IDs. Leave blank to allow any authenticated user.
const ADMIN_UID_ALLOWLIST = (() => {
  const raw =
    (import.meta.env as Record<string, string | undefined>).VITE_ADMIN_UIDS ||
    (import.meta.env as Record<string, string | undefined>).EXPO_PUBLIC_ADMIN_UIDS ||
    ''
  return raw
    .split(',')
    .map((uid) => uid.trim())
    .filter(Boolean)
})()

const isUidAllowed = (uid?: string | null) =>
  !ADMIN_UID_ALLOWLIST.length || (!!uid && ADMIN_UID_ALLOWLIST.includes(uid))

const withTimeout = async <T,>(promise: Promise<T>, ms: number, timeoutMessage: string) => {
  let timer: number | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(timeoutMessage)), ms)
      }),
    ])
  } finally {
    if (timer) window.clearTimeout(timer)
  }
}

const parseFirebaseConfig = (
  raw: string
): { config?: FirebaseOptions; error?: string } => {
  if (!raw.trim()) return { error: 'Paste your Firebase config JSON to enable uploads.' }
  try {
    const parsed = JSON.parse(raw) as FirebaseOptions
    const requiredKeys = ['apiKey', 'projectId', 'storageBucket', 'appId'] as const
    for (const key of requiredKeys) {
      if (!parsed[key]) return { error: `Firebase config is missing ${key}` }
    }
    return { config: parsed }
  } catch (error) {
    return { error: 'Invalid Firebase JSON config.' }
  }
}

const validateLink = (value: string) => {
  const raw = value.trim()
  if (!raw) throw new Error('Link is required')
  const parsed = new URL(raw)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Link must be http or https')
  }
  return parsed.toString()
}

const validateBanner = (form: FormState, editingId?: string): Banner => {
  const id = clamp(form.id.trim(), 64) || toSlug(form.label || 'item')
  const label = clamp(form.label.trim(), 120)
  if (!id) throw new Error('ID is required')
  if (!label) throw new Error('Label is required')
  if (!form.imageUrl.trim()) throw new Error('Upload an image to Firebase first')
  const url = validateLink(form.url)

  return {
    id: editingId || id,
    label,
    url,
    imageUrl: form.imageUrl,
  }
}

function App() {
  const [form, setForm] = useState<FormState>(emptyForm)
  const [banners, setBanners] = useState<Banner[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewSrc, setPreviewSrc] = useState<string>('')
  const [status, setStatus] = useState('Sign in to manage your items.')
  const [errors, setErrors] = useState<string[]>([])
  const [firebaseConfig] = useState(defaultFirebaseConfig)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [authorized, setAuthorized] = useState(false)

  const firebaseSetup = useMemo(() => {
    const parsed = parseFirebaseConfig(firebaseConfig)
    if (parsed.error || !parsed.config) {
      return { status: 'idle', message: parsed.error || 'Firebase config missing' }
    }
    try {
      const existing = getApps().find((app) => app.name === 'cms-app')
      const app = existing ?? initializeApp(parsed.config, 'cms-app')
      const storage = getStorage(app)
      const db = getFirestore(app)
      const auth = getAuth(app)
      return { status: 'ready', storage, db, auth, message: 'Firebase ready' }
    } catch (error) {
      return { status: 'error', message: (error as Error).message }
    }
  }, [firebaseConfig])

  useEffect(() => {
    return () => {
      if (previewSrc.startsWith('blob:')) {
        URL.revokeObjectURL(previewSrc)
      }
    }
  }, [previewSrc])

  useEffect(() => {
    if (firebaseSetup.status !== 'ready' || !firebaseSetup.auth) return
    const unsubscribe = onAuthStateChanged(firebaseSetup.auth, async (next) => {
      if (!next) {
        setUser(null)
        setAuthorized(false)
        setStatus('Please sign in to continue.')
        return
      }
      try {
        const uidAllowed = isUidAllowed(next.uid)
        let denialReason = ''
        let isAdmin = uidAllowed
        if (!uidAllowed && ADMIN_UID_ALLOWLIST.length) {
          denialReason = 'Account not on admin allowlist.'
        }
        if (ENFORCE_ADMIN_ROLE) {
          const token = await getIdTokenResult(next, true)
          const role = (token.claims as Record<string, unknown>).role
          const hasAdminRole = role === 'admin'
          isAdmin = uidAllowed && hasAdminRole
          if (!hasAdminRole) {
            denialReason = 'Account missing admin role.'
          }
        }
        setAuthorized(isAdmin)
        if (isAdmin) {
          setUser(next)
          setStatus(
            `Signed in as ${next.email || 'user'}${
              ENFORCE_ADMIN_ROLE ? ' (admin).' : '.'
            }`
          )
          setAuthError(null)
        } else {
          setUser(null)
          setStatus(denialReason || 'Account not authorized.')
          setAuthError(denialReason || 'Your account is not allowed. Contact an admin.')
          await signOut(firebaseSetup.auth)
        }
      } catch (error) {
        setUser(null)
        setAuthorized(false)
        setAuthError((error as Error).message)
        setStatus('Auth check failed.')
      }
    })
    return unsubscribe
  }, [firebaseSetup])

  useEffect(() => {
    let cancelled = false
    const loadFromFirestore = async () => {
      if (firebaseSetup.status !== 'ready' || !firebaseSetup.db) {
        setBanners(demoBanners)
        setStatus('Firestore not ready; showing demo data.')
        return
      }
      setStatus('Loading items from Firestore...')
      try {
        const snapshot = await getDocs(collection(firebaseSetup.db, 'affiliateItems'))
        if (cancelled) return
        const items = snapshot.docs
          .map((docSnapshot) => {
            const data = docSnapshot.data() as Partial<Banner>
            if (!data.label || !data.url || !data.imageUrl) return null
            return {
              id: data.id || docSnapshot.id,
              label: data.label,
              url: data.url,
              imageUrl: data.imageUrl,
            } satisfies Banner
          })
          .filter(Boolean) as Banner[]
        setBanners(items)
        setStatus(items.length ? 'Loaded items from Firestore.' : 'No items found in Firestore.')
        setErrors([])
      } catch (error) {
        if (cancelled) return
        setBanners(demoBanners)
        setErrors([(error as Error).message])
        setStatus('Failed to load Firestore items; showing demo data.')
      }
    }
    loadFromFirestore()
    return () => {
      cancelled = true
    }
  }, [firebaseSetup])

  const handleFilePick = (files: FileList | null) => {
    if (!files?.length) return
    const [file] = files
    if (!file.type.startsWith('image/')) {
      setErrors(['Upload must be an image file'])
      return
    }
    const objectUrl = URL.createObjectURL(file)
    setSelectedFile(file)
    setPreviewSrc(objectUrl)
    setErrors([])
    setStatus(`Ready to upload "${file.name}" to Firebase Storage.`)
  }

  const handleUploadToStorage = async () => {
    setUploading(true)
    setErrors([])
    try {
      if (!selectedFile) {
        throw new Error('Pick an image before uploading')
      }
      if (firebaseSetup.status !== 'ready' || !firebaseSetup.storage) {
        throw new Error(
          firebaseSetup.message || 'Firebase config missing or invalid (check .env and JSON)'
        )
      }

      const cleanName = selectedFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const storageRef = ref(
        firebaseSetup.storage,
        `affiliateImages/${Date.now()}-${cleanName}`
      )
      await uploadBytes(storageRef, selectedFile)
      setStatus('Image uploaded. Fetching download URL...')
      const url = await withTimeout(
        getDownloadURL(storageRef),
        10000,
        'Timed out fetching download URL. Check Firebase Storage read rules.'
      )
      setForm((prev) => ({ ...prev, imageUrl: url }))
      setStatus('Image uploaded to Firebase Storage and attached to the form.')
    } catch (error) {
      setErrors([(error as Error).message])
      setStatus('Upload failed. See error above.')
    } finally {
      setUploading(false)
    }
  }

  const handleLogin = async () => {
    if (firebaseSetup.status !== 'ready' || !firebaseSetup.auth) {
      setAuthError('Firebase not ready. Check config.')
      return
    }
    setAuthLoading(true)
    setAuthError(null)
    try {
      await signInWithEmailAndPassword(firebaseSetup.auth, authEmail.trim(), authPassword)
    } catch (error) {
      setAuthError((error as Error).message)
    } finally {
      setAuthLoading(false)
    }
  }

  const handleLogout = async () => {
    if (firebaseSetup.status !== 'ready' || !firebaseSetup.auth) return
    await signOut(firebaseSetup.auth)
  }

  const handleSaveBanner = async () => {
    try {
      setSaving(true)
      const validated = validateBanner(form, editingId ?? undefined)
      setBanners((prev) =>
        editingId
          ? prev.map((item) => (item.id === editingId ? validated : item))
          : [validated, ...prev]
      )
      if (firebaseSetup.status === 'ready' && firebaseSetup.db) {
        await setDoc(doc(firebaseSetup.db, 'affiliateItems', validated.id), validated)
        setStatus(editingId ? 'Item updated in Firestore.' : 'Item saved to Firestore.')
      } else {
        setStatus('Item staged locally (Firestore not ready).')
      }
      setErrors([])
      setForm(emptyForm)
      setEditingId(null)
      setSelectedFile(null)
      setPreviewSrc('')
    } catch (error) {
      setErrors([(error as Error).message])
    } finally {
      setSaving(false)
    }
  }

  const handleEdit = (banner: Banner) => {
    setForm({
      id: banner.id,
      label: banner.label,
      url: banner.url,
      imageUrl: banner.imageUrl,
    })
    setPreviewSrc(banner.imageUrl)
    setEditingId(banner.id)
    setStatus('Editing existing banner. Save to apply changes.')
  }

  const handleDelete = (id: string) => {
    setBanners((prev) => prev.filter((item) => item.id !== id))
    if (editingId === id) {
      setForm(emptyForm)
      setEditingId(null)
      setPreviewSrc('')
    }
  }

  return (
    <div className="page">
      {!user || !authorized ? (
        <main className="content">
          <header className="top">
            <div>
              <p className="eyebrow">Welcome back</p>
              <h1>Sign in to manage your catalog</h1>
              <p className="lede">
                Use your email and password to access your items. If you don&apos;t have an account, ask
                the site owner to invite you.
              </p>
            </div>
            <div className="status">
              <span className="status-label">Status</span>
              <span className="status-text">{status}</span>
              {firebaseSetup.message && (
                <span
                  className={`status-pill ${firebaseSetup.status === 'ready' ? 'ok' : 'warn'}`}
                >
                  {firebaseSetup.message}
                </span>
              )}
            </div>
          </header>

          {authError && (
            <div className="callout danger">
              <span>{authError}</span>
            </div>
          )}

          <section className="panels single">
            <div className="panel form-panel">
              <div className="panel-head">
                <h2>Login</h2>
                <span className="hint">Email and password</span>
              </div>
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </label>
              <div className="upload-row">
                <button
                  type="button"
                  className="primary"
                  onClick={handleLogin}
                  disabled={authLoading || firebaseSetup.status !== 'ready'}
                >
                  {authLoading
                    ? 'Signing in...'
                    : firebaseSetup.status !== 'ready'
                      ? 'Firebase not ready'
                      : 'Sign in'}
                </button>
              </div>
              <p className="hint">Forgot your password? Use the reset link from the site owner.</p>
            </div>
          </section>
        </main>
      ) : (
        <main className="content">
        <header className="top">
          <div>
            <p className="eyebrow">Your catalog</p>
            <h1>Manage your featured items</h1>
            <p className="lede">
              Upload a product image, add a title and link, then save. Items are stored securely in
              your account.
            </p>
          </div>
          <div className="status">
            <span className="status-label">Status</span>
            <span className="status-text">{status}</span>
            {firebaseSetup.message && (
              <span
                className={`status-pill ${firebaseSetup.status === 'ready' ? 'ok' : 'warn'}`}
              >
                {firebaseSetup.message}
              </span>
            )}
          </div>
        </header>

        {errors.length > 0 && (
          <div className="callout danger">
            {errors.map((err) => (
              <span key={err}>{err}</span>
            ))}
          </div>
        )}

        <section className="panels single">
          <div className="panel form-panel">
            <div className="panel-head">
              <h2>{editingId ? 'Edit item' : 'Add item'}</h2>
              <span className="hint">All fields are required</span>
            </div>

            <label className="field">
              <span>Item ID</span>
              <input
                value={form.id}
                onChange={(e) => setForm((prev) => ({ ...prev, id: e.target.value }))}
                placeholder="ps5-console"
              />
            </label>

            <label className="field">
              <span>Label</span>
              <input
                value={form.label}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, label: e.target.value }))
                }
                placeholder="🔥 TEST PS5 🔥"
              />
            </label>

            <label className="field">
              <span>Destination URL</span>
              <input
                value={form.url}
                onChange={(e) => setForm((prev) => ({ ...prev, url: e.target.value }))}
                placeholder="https://www.amazon.com/..."
              />
            </label>

              <div className="upload-row">
                <label className="file-picker">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleFilePick(e.target.files)}
                  />
                  {selectedFile ? selectedFile.name : 'Choose file'}
                </label>
                <button
                  type="button"
                  className="primary"
                  onClick={handleUploadToStorage}
                  disabled={uploading || firebaseSetup.status !== 'ready'}
                >
                  {uploading
                    ? 'Uploading...'
                    : firebaseSetup.status !== 'ready'
                    ? 'Setting up...'
                    : 'Upload image'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => handleSaveBanner()}
                  disabled={saving}
              >
                {saving ? 'Saving...' : editingId ? 'Save changes' : 'Add item'}
              </button>
            </div>

            <div className="preview-row">
              <div className="preview-card">
                {previewSrc || form.imageUrl ? (
                  <img src={previewSrc || form.imageUrl} alt="Preview" />
                ) : (
                  <div className="empty">Upload to see a preview</div>
                )}
              </div>
              <div className="small-print">
                <p>
                  Image link: <code className="inline">{form.imageUrl || 'pending upload'}</code>
                </p>
                <p className="hint">
                  Once saved, your link will stay attached to this item.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="panel banners">
          <div className="panel-head">
            <h2>Existing items</h2>
            <span className="hint">
              Click edit to load into the form • Signed in as {user.email || user.uid}
            </span>
            <button type="button" className="ghost" onClick={handleLogout}>
              Sign out
            </button>
          </div>
          <div className="card-grid">
            {banners.map((banner) => (
              <article className="banner-card" key={banner.id}>
                <div className="banner-image">
                  <img src={banner.imageUrl} alt={banner.label} />
                </div>
                <div className="banner-body">
                  <p className="label">{banner.id}</p>
                  <h3>{banner.label}</h3>
                  <a className="subtitle" href={banner.url} target="_blank" rel="noreferrer">
                    {banner.url}
                  </a>
                  <div className="actions">
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => handleEdit(banner)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => handleDelete(banner.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
      )}
    </div>
  )
}

export default App
