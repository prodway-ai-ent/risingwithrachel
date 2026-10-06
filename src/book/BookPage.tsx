import React, { useEffect, useMemo, useState } from 'react';
import Header from '../components/Header';
import Footer from '../components/Footer';
import './book.css';

type Slot = { startsAt: string; label: string; status: string };
type Day = { day: string; label: string; slots: Slot[] };

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const DEFAULT_ZONE = 'America/New_York';

const splitDay = (label: string) => {
  const [weekday, rest] = label.split(', ');
  return { weekday: weekday || label, rest: rest || '' };
};

const monthCells = (year: number, month: number) => {
  const lead = new Date(year, month, 1).getDay();
  const count = new Date(year, month + 1, 0).getDate();
  const cells: Array<{ key: string; date: number | null; iso: string | null }> = [];
  for (let i = 0; i < lead; i += 1) cells.push({ key: `lead-${i}`, date: null, iso: null });
  for (let date = 1; date <= count; date += 1) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
    cells.push({ key: iso, date, iso });
  }
  while (cells.length % 7 !== 0) cells.push({ key: `tail-${cells.length}`, date: null, iso: null });
  return cells;
};

const zoneAbbr = (iso: string, timeZone: string) => {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(new Date(iso))
      .find((p) => p.type === 'timeZoneName');
    return part?.value || '';
  } catch {
    return '';
  }
};

const visitorZone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
})();

const inVisitorZone = (iso: string) => {
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
  } catch {
    return '';
  }
};

const BookPage: React.FC = () => {
  const [days, setDays] = useState<Day[]>([]);
  const [timeZone, setTimeZone] = useState(DEFAULT_ZONE);
  const [zoneLabel, setZoneLabel] = useState('Eastern Time');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<{ when: string; startsAt: string } | null>(null);
  const [month, setMonth] = useState('');
  const [activeDay, setActiveDay] = useState('');
  const [selected, setSelected] = useState<{ slot: Slot; day: Day } | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);

  const byDay = useMemo(() => new Map(days.map((day) => [day.day, day])), [days]);
  const months = useMemo(
    () => days.map((day) => day.day.slice(0, 7)).filter((key, index, all) => all.indexOf(key) === index),
    [days],
  );

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/availability');
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || 'The calendar is unavailable right now.');
      const next: Day[] = body.days || [];
      setDays(next);
      setTimeZone(body.timezone || DEFAULT_ZONE);
      setZoneLabel(body.timezoneLabel || 'Eastern Time');
      setMonth((current) => (current && next.some((day) => day.day.startsWith(current)))
        ? current
        : (next[0] ? next[0].day.slice(0, 7) : current));
    } catch (err: any) {
      setError(err.message || 'The calendar is unavailable right now.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const scrollToPanel = () => {
    window.requestAnimationFrame(() => {
      if (window.innerWidth <= 900) {
        document.querySelector('.rwr-book-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  };

  const openDay = (day: Day) => {
    setActiveDay(day.day);
    setSent(null);
    setError('');
    if (selected && selected.day.day !== day.day) setSelected(null);
    scrollToPanel();
  };

  const choose = (day: Day, slot: Slot) => {
    setSelected({ day, slot });
    setError('');
    scrollToPanel();
  };

  const reset = () => {
    setSent(null);
    setSelected(null);
    setActiveDay('');
    setError('');
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, phone, startsAt: selected.slot.startsAt }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || 'Could not send the request.');
      setSent({ when: whenText(selected), startsAt: selected.slot.startsAt });
      setSelected(null);
      setActiveDay('');
      setName('');
      setEmail('');
      setPhone('');
      await load();
    } catch (err: any) {
      setError(err.message || 'Could not send the request.');
      await load();
    } finally {
      setSaving(false);
    }
  };

  const whenText = (pick: { slot: Slot; day: Day }) => {
    const parts = splitDay(pick.day.label);
    return `${parts.weekday}, ${parts.rest} at ${pick.slot.label} ${zoneAbbr(pick.slot.startsAt, timeZone)}`.trim();
  };

  const [yearText, monthText] = (month || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`).split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const monthLabel = new Date(year, monthIndex, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const monthAt = months.indexOf(month);
  const opened = byDay.get(activeDay);
  const openedParts = opened ? splitDay(opened.label) : null;
  const showLocal = Boolean(visitorZone) && visitorZone !== timeZone;
  const step: 'day' | 'time' | 'form' | 'done' = sent ? 'done' : selected ? 'form' : opened ? 'time' : 'day';

  return (
    <div className="rwr-book">
      <Header />
      <main className="rwr-book-main">
        <div className="rwr-container">
          <header className="rwr-book-head">
            <span className="rwr-eyebrow">Book a session</span>
            <h1>Pick a day.</h1>
            <p className="rwr-lead">
              Choose a day and available time to request a phone call. Rachel will review your request and follow up to confirm.
            </p>
          </header>

          {error && step !== 'form' && <p className="rwr-book-error">{error}</p>}

          <div className="rwr-book-layout">
            <div className="rwr-book-calendar">
              {loading ? (
                <div className="rwr-book-skeleton" aria-hidden="true"><div /></div>
              ) : (
                <section className="rwr-cal" aria-label={monthLabel}>
                  <header className="rwr-cal-head">
                    <h2>{monthLabel}</h2>
                    <div className="rwr-cal-nav">
                      <button type="button" aria-label="Previous month" disabled={monthAt <= 0} onClick={() => setMonth(months[monthAt - 1])}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18 9 12l6-6" /></svg>
                      </button>
                      <button type="button" aria-label="Next month" disabled={monthAt < 0 || monthAt >= months.length - 1} onClick={() => setMonth(months[monthAt + 1])}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
                      </button>
                    </div>
                  </header>
                  <div className="rwr-cal-week" aria-hidden="true">
                    {WEEKDAYS.map((label) => <span key={label}>{label}</span>)}
                  </div>
                  <div className="rwr-cal-grid">
                    {monthCells(year, monthIndex).map((cell) => {
                      if (!cell.iso || cell.date === null) return <span key={cell.key} className="is-pad" />;
                      const day = byDay.get(cell.iso);
                      if (!day) return <span key={cell.key} className="is-off">{cell.date}</span>;
                      const openCount = day.slots.filter((slot) => slot.status === 'available').length;
                      const picked = activeDay === cell.iso;
                      return (
                        <button
                          key={cell.key}
                          type="button"
                          className={picked ? 'is-picked' : 'is-on'}
                          aria-pressed={picked}
                          aria-label={`${day.label}, ${openCount} available`}
                          onClick={() => openDay(day)}
                        >
                          {cell.date}
                          <i className="dot" />
                        </button>
                      );
                    })}
                  </div>
                  <p className="rwr-cal-legend"><i className="dot" /> Days with times available to request</p>
                  {!days.length && <p className="rwr-cal-none">No times are open to request right now. Please check back soon.</p>}
                </section>
              )}
            </div>

            <aside className="rwr-book-panel" data-step={step}>
              {step === 'done' && sent && (
                <div className="rwr-book-success">
                  <span className="check" aria-hidden="true">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </span>
                  <p className="rwr-book-when">Request sent</p>
                  <h2>Pending Rachel's review</h2>
                  <p>Your request for <strong>{sent.when}</strong> is in. This is not a confirmed appointment yet. Rachel will review it and follow up by email to confirm.</p>
                  <button type="button" className="rwr-btn rwr-btn--ghost" onClick={reset}>Request another time</button>
                </div>
              )}

              {step === 'form' && selected && (
                <form onSubmit={submit}>
                  <p className="rwr-book-when">{whenText(selected)}</p>
                  <h2>Request this hour</h2>
                  <p className="sub">
                    Rachel will review your request and follow up to confirm.
                    {showLocal && <> That is {inVisitorZone(selected.slot.startsAt)} where you are.</>}
                  </p>
                  {error && <p className="rwr-book-error">{error}</p>}
                  <label><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" /></label>
                  <label><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></label>
                  <label><span>Phone <em>optional</em></span><input value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" /></label>
                  <button className="rwr-btn rwr-btn--solid" type="submit" disabled={saving}>
                    {saving ? 'Sending…' : 'Send request'}
                    {!saving && (
                      <svg className="rwr-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12h14M13 6l6 6-6 6" />
                      </svg>
                    )}
                  </button>
                  <button type="button" className="rwr-book-link" onClick={() => setSelected(null)}>Change time</button>
                </form>
              )}

              {step === 'time' && opened && openedParts && (
                <div className="rwr-book-hours">
                  <p className="rwr-book-when">{openedParts.rest} · {zoneLabel}{zoneAbbr(opened.slots[0]?.startsAt || '', timeZone) ? ` (${zoneAbbr(opened.slots[0].startsAt, timeZone)})` : ''}</p>
                  <h2>{openedParts.weekday}</h2>
                  <p className="sub">Choose an available time.</p>
                  <div className="rwr-book-slots">
                    {opened.slots.map((slot) => {
                      const available = slot.status === 'available';
                      return (
                        <button
                          key={slot.startsAt}
                          type="button"
                          className={available ? 'is-open' : 'is-taken'}
                          disabled={!available}
                          onClick={() => choose(opened, slot)}
                        >
                          <strong>{slot.label}</strong>
                          <span>{available ? 'Available' : 'Unavailable'}</span>
                        </button>
                      );
                    })}
                  </div>
                  {showLocal && <p className="rwr-book-fine">Times are shown in {zoneLabel}. Your local time appears after you pick one.</p>}
                </div>
              )}

              {step === 'day' && (
                <div className="rwr-book-empty">
                  <span className="mark" aria-hidden="true">RR</span>
                  <h2>Choose a day</h2>
                  <p>Marked days have times available to request, shown in {zoneLabel}. Pick one to see its hours.</p>
                </div>
              )}
            </aside>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default BookPage;
