import React, { useCallback, useEffect, useState } from 'react';
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
  client_id?: number | null;
};

type Client = {
  id: number;
  created_at: string;
  name: string;
  email: string;
  phone?: string;
  location?: string;
  notes?: string;
};

type Session = {
  id: number;
  starts_at: string;
  ends_at: string;
  status: string;
  calendar_sync_status?: string;
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

const recentCount = (rows: { created_at: string }[]) => rows.reduce((count, row) => {
  const d = new Date((row.created_at || '').replace(' ', 'T') + 'Z');
  return count + (Date.now() - d.getTime() < 7 * 864e5 ? 1 : 0);
}, 0);

const formatDate = (s: string) => {
  const d = new Date(s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

type CalendarSlot = {
  startsAt: string;
  label: string;
  status: string;
  sessionId?: number;
  blockId?: number;
  reason?: string | null;
  name?: string;
  email?: string;
};

type CalendarDay = { day: string; label: string; slots: CalendarSlot[] };
type HoursRule = { weekday: number; name: string; active: boolean; start_minute: number; end_minute: number };

const SLOT_LABELS: Record<string, string> = {
  available: 'Available',
  blocked: 'Blocked',
  pending: 'Pending request',
  approved: 'Approved',
  scheduled: 'Scheduled',
};

const HOUR_OPTIONS = Array.from({ length: 25 }, (_, hour) => {
  const minute = hour * 60;
  const label = hour === 0 || hour === 24 ? '12 AM' : hour === 12 ? '12 PM' : hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
  return { minute, label };
});

const Dashboard: React.FC<{ token: string; onLogout: () => void }> = ({ token, onLogout }) => {
  const [view, setView] = useState<'inquiries' | 'clients' | 'calendar'>('inquiries');
  const [subs, setSubs] = useState<Submission[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Submission | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [clientInquiries, setClientInquiries] = useState<Submission[]>([]);
  const [notes, setNotes] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [hoursLabel, setHoursLabel] = useState('Monday through Friday, 9 AM to 5 PM Eastern');
  const [startsAt, setStartsAt] = useState('');
  const [duration, setDuration] = useState('60');
  const [days, setDays] = useState<CalendarDay[]>([]);
  const [zoneLabel, setZoneLabel] = useState('Eastern Time');
  const [slotMinutes, setSlotMinutes] = useState(60);
  const [rules, setRules] = useState<HoursRule[]>([]);
  const [editingHours, setEditingHours] = useState(false);
  const [saving, setSaving] = useState(false);

  const api = useCallback(async (path: string, options: RequestInit = {}) => {
    const res = await fetch(path, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (res.status === 401) { onLogout(); throw new Error('Unauthorized'); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error || 'Request failed');
    return body;
  }, [token, onLogout]);

  const exportCsv = async () => {
    const res = await fetch('/api/admin/export', { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) { onLogout(); return; }
    if (!res.ok) { setError('Could not export'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'rising-with-rachel.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const loadCalendar = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [body, settings] = await Promise.all([api('/api/admin/calendar'), api('/api/admin/availability')]);
      setDays(body.days || []);
      if (body.availabilityLabel) setHoursLabel(body.availabilityLabel);
      if (body.timezoneLabel) setZoneLabel(body.timezoneLabel);
      if (body.slotMinutes) setSlotMinutes(Number(body.slotMinutes));
      setRules(settings.rules || []);
    } catch (err: any) {
      if (err.message !== 'Unauthorized') setError(err.message || 'Failed to load the calendar');
    } finally {
      setLoading(false);
    }
  }, [api]);

  const runCalendarAction = async (work: () => Promise<unknown>, fallback: string) => {
    setSaving(true);
    setError('');
    try {
      await work();
      await loadCalendar();
    } catch (err: any) {
      setError(err.message || fallback);
    } finally {
      setSaving(false);
    }
  };

  const decide = (id: number, action: 'accept' | 'deny' | 'cancel') =>
    runCalendarAction(() => api(`/api/admin/sessions/${id}/${action}`, { method: 'POST' }), 'Could not update the request');

  const blockSlot = (slot: CalendarSlot) => runCalendarAction(() => api('/api/admin/blocks', {
    method: 'POST',
    body: JSON.stringify({
      startsAt: slot.startsAt,
      endsAt: new Date(new Date(slot.startsAt).getTime() + slotMinutes * 60000).toISOString(),
    }),
  }), 'Could not block that hour');

  const blockDay = (day: CalendarDay) => {
    const open = day.slots.filter((slot) => slot.status === 'available');
    if (!open.length) return;
    const first = open[0].startsAt;
    const last = new Date(new Date(open[open.length - 1].startsAt).getTime() + slotMinutes * 60000).toISOString();
    return runCalendarAction(() => api('/api/admin/blocks', {
      method: 'POST',
      body: JSON.stringify({ startsAt: first, endsAt: last, reason: 'Day off' }),
    }), 'Could not block that day');
  };

  const unblock = (blockId: number) =>
    runCalendarAction(() => api(`/api/admin/blocks/${blockId}`, { method: 'DELETE' }), 'Could not reopen that hour');

  const updateRule = (weekday: number, patch: Partial<HoursRule>) =>
    setRules((rows) => rows.map((row) => row.weekday === weekday ? { ...row, ...patch } : row));

  const saveHours = () => runCalendarAction(async () => {
    const body = await api('/api/admin/availability', { method: 'PUT', body: JSON.stringify({ rules }) });
    setRules(body.rules || []);
    setEditingHours(false);
  }, 'Could not save the weekly hours');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [inquiryBody, clientBody] = await Promise.all([
        api('/api/admin/submissions'),
        api('/api/admin/clients'),
      ]);
      setSubs(inquiryBody.submissions || []);
      setClients(clientBody.clients || []);
    } catch (err: any) {
      if (err.message !== 'Unauthorized') setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const openClient = async (id: number) => {
    const body = await api(`/api/admin/clients/${id}`);
    setSelected(null);
    setClient(body.client);
    setNotes(body.client.notes || '');
    setClientInquiries(body.submissions || []);
    setSessions(body.sessions || []);
    setHoursLabel(body.availabilityLabel || hoursLabel);
    setView('clients');
  };

  const createFromInquiry = async (inquiry: Submission) => {
    setSaving(true);
    setError('');
    try {
      const body = await api('/api/admin/clients', {
        method: 'POST',
        body: JSON.stringify({
          name: inquiry.name,
          email: inquiry.email,
          phone: inquiry.phone,
          location: inquiry.location,
          submissionId: inquiry.id,
        }),
      });
      setSubs((rows) => rows.map((row) => row.id === inquiry.id ? { ...row, client_id: body.client.id } : row));
      await openClient(body.client.id);
      const clientBody = await api('/api/admin/clients');
      setClients(clientBody.clients || []);
    } catch (err: any) {
      setError(err.message || 'Could not create client');
    } finally {
      setSaving(false);
    }
  };

  const calendarNote = (session: Session) => {
    if (session.calendar_sync_status === 'synced') return 'On the external calendar';
    if (session.calendar_sync_status === 'error') return 'Calendar sync needs attention';
    return SLOT_LABELS[session.status] || session.status;
  };

  const bookSession = async () => {
    if (!client) return;
    setSaving(true);
    setError('');
    try {
      const body = await api('/api/admin/sessions', {
        method: 'POST',
        body: JSON.stringify({ clientId: client.id, startsAt, durationMinutes: Number(duration) }),
      });
      setSessions((rows) => [...rows, body.session].sort((a, b) => a.starts_at.localeCompare(b.starts_at)));
      setStartsAt('');
      if (body.emailError) setError(body.emailError);
    } catch (err: any) {
      setError(err.message || 'Could not book the session');
    } finally {
      setSaving(false);
    }
  };

  const cancelSession = async (id: number) => {
    setSaving(true);
    setError('');
    try {
      await api(`/api/admin/sessions/${id}/cancel`, { method: 'POST' });
      setSessions((rows) => rows.filter((row) => row.id !== id));
    } catch (err: any) {
      setError(err.message || 'Could not cancel the session');
    } finally {
      setSaving(false);
    }
  };

  const saveNotes = async () => {
    if (!client) return;
    setSaving(true);
    setError('');
    try {
      const body = await api(`/api/admin/clients/${client.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ notes }),
      });
      setClient(body.client);
      setClients((rows) => rows.map((row) => row.id === body.client.id ? body.client : row));
    } catch (err: any) {
      setError(err.message || 'Could not save notes');
    } finally {
      setSaving(false);
    }
  };

  const matches = (values: Array<string | undefined>) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return values.filter(Boolean).join(' ').toLowerCase().includes(q);
  };
  const filteredInquiries = subs.filter((s) => matches([s.name, s.email, s.location, s.goals, s.message]));
  const filteredClients = clients.filter((s) => matches([s.name, s.email, s.location, s.notes]));
  const filtered: Array<Submission | Client> = view === 'clients' ? filteredClients : filteredInquiries;

  return (
    <div className="rwr-admin">
      <header className="rwr-admin-header">
        <div className="rwr-admin-brand">
          <span className="rwr-admin-logo sm">RR</span>
          <div>
            <strong>Rising with Rachel</strong>
            <span>{view === 'calendar' ? 'Calendar' : view === 'clients' ? 'Clients' : 'Client inquiries'}</span>
          </div>
        </div>
        <div className="rwr-admin-actions">
          <button type="button" className={`rwr-admin-ghost${view === 'inquiries' ? ' is-on' : ''}`} onClick={() => { setView('inquiries'); setClient(null); }}>Inquiries</button>
          <button type="button" className={`rwr-admin-ghost${view === 'clients' ? ' is-on' : ''}`} onClick={() => { setView('clients'); setSelected(null); }}>Clients</button>
          <button type="button" className={`rwr-admin-ghost${view === 'calendar' ? ' is-on' : ''}`} onClick={() => { setView('calendar'); setSelected(null); setClient(null); loadCalendar(); }}>Calendar</button>
          <input className="rwr-admin-search" placeholder={view === 'clients' ? 'Search clients…' : 'Search inquiries…'} value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="rwr-admin-ghost" onClick={() => view === 'calendar' ? loadCalendar() : load()} title="Refresh">↻</button>
          <button className="rwr-admin-ghost" onClick={exportCsv}>Export</button>
          <button className="rwr-admin-ghost" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      {view !== 'calendar' && <div className="rwr-admin-stats">
        <motion.div className="rwr-admin-stat" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Counter className="rwr-admin-stat-num" to={view === 'clients' ? clients.length : subs.length} />
          <span className="rwr-admin-stat-label">{view === 'clients' ? 'Clients' : 'Total inquiries'}</span>
        </motion.div>
        <motion.div className="rwr-admin-stat" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <Counter
            className="rwr-admin-stat-num"
            to={view === 'clients' ? recentCount(clients) : recentCount(subs)}
          />
          <span className="rwr-admin-stat-label">Last 7 days</span>
        </motion.div>
      </div>}

      <main className="rwr-admin-main">
        {view === 'calendar' && (
          <div className="rwr-admin-calendar">
            <div className="rwr-admin-hours-head">
              <p className="rwr-admin-muted">{hoursLabel}. Times in {zoneLabel}. Visitors can request any available hour; nothing is confirmed until you approve it.</p>
              <button type="button" className={`rwr-admin-ghost${editingHours ? ' is-on' : ''}`} onClick={() => setEditingHours((on) => !on)}>
                {editingHours ? 'Close' : 'Weekly hours'}
              </button>
            </div>
            {editingHours && (
              <section className="rwr-admin-day rwr-admin-hours">
                <h3>Weekly hours</h3>
                <p className="rwr-admin-muted">Uncheck a day to take it off the calendar. Changes apply to future requests only.</p>
                <div className="rwr-admin-hours-grid">
                  {rules.map((rule) => (
                    <div key={rule.weekday} className={`rwr-admin-hours-row${rule.active ? '' : ' is-off'}`}>
                      <label className="rwr-admin-hours-day">
                        <input type="checkbox" checked={rule.active} onChange={(e) => updateRule(rule.weekday, { active: e.target.checked })} />
                        <span>{rule.name}</span>
                      </label>
                      <select value={rule.start_minute} disabled={!rule.active} onChange={(e) => updateRule(rule.weekday, { start_minute: Number(e.target.value) })}>
                        {HOUR_OPTIONS.slice(0, 24).map((option) => <option key={option.minute} value={option.minute}>{option.label}</option>)}
                      </select>
                      <span className="rwr-admin-muted">to</span>
                      <select value={rule.end_minute} disabled={!rule.active} onChange={(e) => updateRule(rule.weekday, { end_minute: Number(e.target.value) })}>
                        {HOUR_OPTIONS.slice(1).map((option) => <option key={option.minute} value={option.minute}>{option.label}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                <div className="rwr-admin-drawer-actions">
                  <button type="button" className="rwr-admin-reply" disabled={saving} onClick={saveHours}>Save hours</button>
                  <button type="button" className="rwr-admin-ghost" disabled={saving} onClick={() => { setEditingHours(false); loadCalendar(); }}>Discard</button>
                </div>
              </section>
            )}
            {error && !loading && <div className="rwr-admin-empty">{error}</div>}
            {loading ? <div className="rwr-admin-empty">Loading the calendar…</div> : days.length === 0 ? (
              <div className="rwr-admin-empty">No hours on the calendar. Set weekly hours to open days for requests.</div>
            ) : days.map((day) => (
              <section key={day.day} className="rwr-admin-day">
                <div className="rwr-admin-day-head">
                  <h3>{day.label}</h3>
                  {day.slots.some((slot) => slot.status === 'available') && (
                    <button type="button" className="rwr-admin-ghost" disabled={saving} onClick={() => blockDay(day)}>Block day</button>
                  )}
                </div>
                <div className="rwr-admin-slots">
                  {day.slots.map((slot) => (
                    <div key={slot.startsAt} className={`rwr-admin-slot is-${slot.status}`}>
                      <div>
                        <strong>{slot.label}</strong>
                        {slot.name && <span className="rwr-admin-muted">{slot.name}{slot.email ? ` · ${slot.email}` : ''}</span>}
                        <span className="rwr-admin-muted">{SLOT_LABELS[slot.status] || slot.status}{slot.status === 'blocked' && slot.reason ? ` · ${slot.reason}` : ''}</span>
                      </div>
                      {slot.status === 'pending' && slot.sessionId && (
                        <div className="rwr-admin-slot-actions">
                          <button type="button" className="rwr-admin-reply" disabled={saving} onClick={() => decide(slot.sessionId as number, 'accept')}>Approve</button>
                          <button type="button" className="rwr-admin-ghost" disabled={saving} onClick={() => decide(slot.sessionId as number, 'deny')}>Decline</button>
                        </div>
                      )}
                      {(slot.status === 'scheduled' || slot.status === 'approved') && slot.sessionId && (
                        <button type="button" className="rwr-admin-ghost" disabled={saving} onClick={() => decide(slot.sessionId as number, 'cancel')}>Cancel</button>
                      )}
                      {slot.status === 'available' && (
                        <button type="button" className="rwr-admin-ghost" disabled={saving} onClick={() => blockSlot(slot)}>Block</button>
                      )}
                      {slot.status === 'blocked' && slot.blockId && (
                        <button type="button" className="rwr-admin-ghost" disabled={saving} onClick={() => unblock(slot.blockId as number)}>Unblock</button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
        {view !== 'calendar' && error && !loading && <div className="rwr-admin-empty">{error}</div>}
        {view !== 'calendar' && loading ? (
          <div className="rwr-admin-skeletons">
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="rwr-admin-skeleton" />)}
          </div>
        ) : view !== 'calendar' && filtered.length === 0 ? (
          <div className="rwr-admin-empty">{view === 'clients' ? 'No clients yet.' : 'No inquiries yet.'}</div>
        ) : view !== 'calendar' ? (
          <motion.ul className="rwr-admin-list" initial="hidden" animate="show"
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}>
            <AnimatePresence>
              {filtered.map((s) => (
                <motion.li
                  key={`${view}-${s.id}`}
                  layout
                  variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }}
                  whileHover={{ scale: 1.008 }}
                  className="rwr-admin-row"
                  onClick={() => view === 'clients' ? openClient(Number(s.id)) : setSelected(s as Submission)}
                >
                  <div className="rwr-admin-avatar">{(s.name || '?').charAt(0).toUpperCase()}</div>
                  <div className="rwr-admin-row-main">
                    <div className="rwr-admin-row-top">
                      <strong>{s.name}</strong>
                      <span className="rwr-admin-date">{formatDate(s.created_at)}</span>
                    </div>
                    <div className="rwr-admin-row-sub">
                      <span>{s.email}</span>
                      {'experience' in s && s.experience && <span className="rwr-admin-chip">{s.experience}</span>}
                      {'client_id' in s && s.client_id && <span className="rwr-admin-chip">Client</span>}
                      {s.location && <span className="rwr-admin-muted">{s.location}</span>}
                    </div>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>
        ) : null}
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
              <div className="rwr-admin-drawer-actions">
                {selected.client_id ? (
                  <button type="button" className="rwr-admin-reply" onClick={() => openClient(Number(selected.client_id))}>View client</button>
                ) : (
                  <button type="button" className="rwr-admin-reply" disabled={saving} onClick={() => createFromInquiry(selected)}>
                    {saving ? 'Saving…' : 'Create client'}
                  </button>
                )}
                <a className="rwr-admin-reply is-quiet" href={`mailto:${selected.email}`}>Reply by email</a>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {client && (
          <motion.div className="rwr-admin-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setClient(null)}>
            <motion.div className="rwr-admin-drawer"
              initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 320, damping: 32 }}
              onClick={(e) => e.stopPropagation()}>
              <button className="rwr-admin-close" onClick={() => setClient(null)}>×</button>
              <div className="rwr-admin-avatar lg">{(client.name || '?').charAt(0).toUpperCase()}</div>
              <h2>{client.name}</h2>
              <span className="rwr-admin-date">{formatDate(client.created_at)}</span>
              <dl className="rwr-admin-detail">
                <Field label="Email" value={client.email} />
                <Field label="Phone" value={client.phone} />
                <Field label="Location" value={client.location} />
              </dl>
              <label className="rwr-admin-field">
                <span>Notes</span>
                <textarea className="rwr-admin-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
              <button type="button" className="rwr-admin-reply" disabled={saving} onClick={saveNotes}>
                {saving ? 'Saving…' : 'Save notes'}
              </button>
              <div className="rwr-admin-detail">
                <div className="rwr-admin-field">
                  <span>Sessions</span>
                  <p className="rwr-admin-muted">{hoursLabel}</p>
                  {sessions.map((session) => (
                    <div key={session.id} className="rwr-admin-session">
                      <div>
                        <strong>{formatDate(session.starts_at)}</strong>
                        <span className="rwr-admin-muted">{calendarNote(session)}</span>
                      </div>
                      <button type="button" className="rwr-admin-ghost" disabled={saving} onClick={() => cancelSession(session.id)}>Cancel</button>
                    </div>
                  ))}
                  <label className="rwr-admin-field">
                    <span>Start, Eastern time</span>
                    <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                  </label>
                  <label className="rwr-admin-field">
                    <span>Length</span>
                    <select value={duration} onChange={(e) => setDuration(e.target.value)}>
                      <option value="30">30 minutes</option>
                      <option value="45">45 minutes</option>
                      <option value="60">60 minutes</option>
                      <option value="90">90 minutes</option>
                    </select>
                  </label>
                  <button type="button" className="rwr-admin-reply" disabled={saving || !startsAt} onClick={bookSession}>
                    {saving ? 'Saving…' : 'Book session'}
                  </button>
                </div>
              </div>
              {clientInquiries.length > 0 && (
                <div className="rwr-admin-detail">
                  {clientInquiries.map((inquiry) => (
                    <Field key={inquiry.id} label={formatDate(inquiry.created_at)} value={inquiry.goals || inquiry.message || inquiry.experience} />
                  ))}
                </div>
              )}
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
