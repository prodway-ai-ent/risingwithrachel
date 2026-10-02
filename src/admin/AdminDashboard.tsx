import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Counter from '../components/Counter';
import './admin.css';

type Submission = {
  id: number | string;
  created_at: string;
  name: string;
  email: string;
  phone?: string;
  location?: string;
  experience?: string;
  preferred_contact?: string;
  goals?: string;
  message?: string;
};

const TOKEN_KEY = 'rwr_admin_token';
type LoginStep = 'password' | 'new_password' | 'mfa_setup' | 'totp';

const Login: React.FC<{ onAuthed: (token: string) => void }> = ({ onAuthed }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nextValue, setNextValue] = useState('');
  const [step, setStep] = useState<LoginStep>('password');
  const [session, setSession] = useState('');
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const payload = step === 'password'
      ? { email, password }
      : step === 'new_password'
        ? { email, session, challenge: 'NEW_PASSWORD', newPassword: nextValue }
        : { email, session, challenge: step === 'mfa_setup' ? 'MFA_SETUP' : 'SOFTWARE_TOKEN_MFA', code: nextValue };
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || 'Login failed');
      if (body.token) {
        sessionStorage.setItem(TOKEN_KEY, body.token);
        onAuthed(body.token);
        return;
      }
      setSession(body.session || '');
      setSecret(body.secret || '');
      setNextValue('');
      if (body.challenge === 'NEW_PASSWORD') setStep('new_password');
      else if (body.challenge === 'MFA_SETUP') setStep('mfa_setup');
      else setStep('totp');
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const prompt = step === 'new_password'
    ? 'Choose a new password'
    : step === 'mfa_setup'
      ? 'Add this key to an authenticator app, then enter the 6-digit code.'
      : step === 'totp'
        ? 'Enter the code from your authenticator app.'
        : 'Admin dashboard';
  const canSubmit = step === 'password'
    ? Boolean(email && password)
    : Boolean(nextValue);

  return (
    <div className="rwr-admin-login">
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="rwr-admin-login-card"
      >
        <div className="rwr-admin-logo">RR</div>
        <h1>Rising with Rachel</h1>
        <p>{prompt}</p>
        {step === 'password' && (
          <>
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" />
            <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </>
        )}
        {step === 'new_password' && (
          <input type="password" placeholder="New password" value={nextValue} onChange={(e) => setNextValue(e.target.value)} autoFocus autoComplete="new-password" />
        )}
        {(step === 'mfa_setup' || step === 'totp') && (
          <>
            {step === 'mfa_setup' && secret && <code className="rwr-admin-secret">{secret}</code>}
            <input inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={nextValue} onChange={(e) => setNextValue(e.target.value)} autoFocus />
          </>
        )}
        <AnimatePresence>
          {error && (
            <motion.div
              className="rwr-admin-error"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
            >
              {error}
            </motion.div>
          )}
        </AnimatePresence>
        <button type="submit" disabled={loading || !canSubmit}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </motion.form>
    </div>
  );
};

const formatDate = (s: string) => {
  const d = new Date(s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const Dashboard: React.FC<{ token: string; onLogout: () => void }> = ({ token, onLogout }) => {
  const [subs, setSubs] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Submission | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/submissions', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { onLogout(); return; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error || 'Failed to load');
      setSubs(body.submissions || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [token, onLogout]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return subs;
    return subs.filter((s) =>
      [s.name, s.email, s.location, s.goals, s.message].filter(Boolean).join(' ').toLowerCase().includes(q)
    );
  }, [subs, query]);

  return (
    <div className="rwr-admin">
      <header className="rwr-admin-header">
        <div className="rwr-admin-brand">
          <span className="rwr-admin-logo sm">RR</span>
          <div>
            <strong>Rising with Rachel</strong>
            <span>Client inquiries</span>
          </div>
        </div>
        <div className="rwr-admin-actions">
          <input className="rwr-admin-search" placeholder="Search inquiries…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="rwr-admin-ghost" onClick={load} title="Refresh">↻</button>
          <button className="rwr-admin-ghost" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <div className="rwr-admin-stats">
        <motion.div className="rwr-admin-stat" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Counter className="rwr-admin-stat-num" to={subs.length} />
          <span className="rwr-admin-stat-label">Total inquiries</span>
        </motion.div>
        <motion.div className="rwr-admin-stat" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <Counter
            className="rwr-admin-stat-num"
            to={subs.filter((s) => {
              const d = new Date((s.created_at || '').replace(' ', 'T') + 'Z');
              return Date.now() - d.getTime() < 7 * 864e5;
            }).length}
          />
          <span className="rwr-admin-stat-label">Last 7 days</span>
        </motion.div>
      </div>

      <main className="rwr-admin-main">
        {loading ? (
          <div className="rwr-admin-skeletons">
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="rwr-admin-skeleton" />)}
          </div>
        ) : error ? (
          <div className="rwr-admin-empty">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="rwr-admin-empty">No inquiries yet.</div>
        ) : (
          <motion.ul className="rwr-admin-list" initial="hidden" animate="show"
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}>
            <AnimatePresence>
              {filtered.map((s) => (
                <motion.li
                  key={s.id}
                  layout
                  variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }}
                  whileHover={{ scale: 1.008 }}
                  className="rwr-admin-row"
                  onClick={() => setSelected(s)}
                >
                  <div className="rwr-admin-avatar">{(s.name || '?').charAt(0).toUpperCase()}</div>
                  <div className="rwr-admin-row-main">
                    <div className="rwr-admin-row-top">
                      <strong>{s.name}</strong>
                      <span className="rwr-admin-date">{formatDate(s.created_at)}</span>
                    </div>
                    <div className="rwr-admin-row-sub">
                      <span>{s.email}</span>
                      {s.experience && <span className="rwr-admin-chip">{s.experience}</span>}
                      {s.location && <span className="rwr-admin-muted">{s.location}</span>}
                    </div>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>
        )}
      </main>

      <AnimatePresence>
        {selected && (
          <motion.div className="rwr-admin-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setSelected(null)}>
            <motion.div className="rwr-admin-drawer"
              initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 320, damping: 32 }}
              onClick={(e) => e.stopPropagation()}>
              <button className="rwr-admin-close" onClick={() => setSelected(null)}>×</button>
              <div className="rwr-admin-avatar lg">{(selected.name || '?').charAt(0).toUpperCase()}</div>
              <h2>{selected.name}</h2>
              <span className="rwr-admin-date">{formatDate(selected.created_at)}</span>
              <dl className="rwr-admin-detail">
                <Field label="Email" value={selected.email} />
                <Field label="Phone" value={selected.phone} />
                <Field label="Location" value={selected.location} />
                <Field label="Experience" value={selected.experience} />
                <Field label="Preferred contact" value={selected.preferred_contact} />
                <Field label="Goals" value={selected.goals} />
                <Field label="Message" value={selected.message} />
              </dl>
              <a className="rwr-admin-reply" href={`mailto:${selected.email}`}>Reply by email</a>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const Field: React.FC<{ label: string; value?: string }> = ({ label, value }) =>
  value ? (
    <div className="rwr-admin-field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  ) : null;

const AdminDashboard: React.FC = () => {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const logout = () => { sessionStorage.removeItem(TOKEN_KEY); setToken(null); };
  return token ? <Dashboard token={token} onLogout={logout} /> : <Login onAuthed={setToken} />;
};

export default AdminDashboard;
