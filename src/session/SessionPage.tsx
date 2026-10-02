import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import '../admin/admin.css';

type Managed = {
  status: string;
  starts_at: string;
  ends_at: string;
  name: string;
};

const asDate = (value: string) => new Date(value.includes('T') || value.includes('Z') ? value : value.replace(' ', 'T') + 'Z');

const formatDate = (value: string) => {
  const date = asDate(value);
  if (isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const SessionPage: React.FC = () => {
  const { token = '' } = useParams();
  const [session, setSession] = useState<Managed | null>(null);
  const [hours, setHours] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [startsAt, setStartsAt] = useState('');
  const [duration, setDuration] = useState('60');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/session/${token}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || 'This link is not valid.');
      setSession(body.session);
      setHours(body.availabilityLabel || '');
    } catch (err: any) {
      setSession(null);
      setError(err.message || 'This link is not valid.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = async (path: string, payload?: object) => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || 'Request failed');
      setNotice(body.notice || 'Saved.');
      await load();
    } catch (err: any) {
      setError(err.message || 'Request failed');
    } finally {
      setSaving(false);
    }
  };

  const upcoming = session?.status === 'scheduled' && asDate(session.starts_at).getTime() > Date.now();

  return (
    <div className="rwr-admin-login">
      <div className="rwr-admin-login-card" style={{ textAlign: 'left' }}>
        <div className="rwr-admin-logo">RR</div>
        <h1 style={{ textAlign: 'center' }}>Your session</h1>
        {loading && <p style={{ textAlign: 'center' }}>Loading…</p>}
        {!loading && error && <div className="rwr-admin-error">{error}</div>}
        {!loading && notice && <p>{notice}</p>}
        {!loading && session && (
          <>
            <p style={{ textAlign: 'center' }}>{session.name}</p>
            <p style={{ textAlign: 'center' }}>{formatDate(session.starts_at)}</p>
            {session.status === 'cancelled' && <p style={{ textAlign: 'center' }}>This session is cancelled.</p>}
            {upcoming && (
              <>
                <button type="button" disabled={saving} onClick={() => post(`/api/session/${token}/cancel`)}>
                  {saving ? 'Saving…' : 'Cancel session'}
                </button>
                <label className="rwr-admin-field">
                  <span>New start, Central time</span>
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
                {hours && <p>{hours}</p>}
                <button type="button" disabled={saving || !startsAt} onClick={() => post(`/api/session/${token}/reschedule`, { startsAt, durationMinutes: Number(duration) })}>
                  {saving ? 'Saving…' : 'Reschedule'}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default SessionPage;
