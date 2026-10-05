import React, { useEffect, useMemo, useState } from 'react';
import Header from '../components/Header';
import Footer from '../components/Footer';
import './book.css';

type Slot = { startsAt: string; label: string; status: string };
type Day = { day: string; label: string; slots: Slot[] };

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

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

const BookPage: React.FC = () => {
  const [days, setDays] = useState<Day[]>([]);
  const [hours, setHours] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [month, setMonth] = useState('');
  const [activeDay, setActiveDay] = useState('');
  const [selected, setSelected] = useState<{ slot: Slot; day: Day } | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);

  const byDay = useMemo(() => new Map(days.map((day) => [day.day, day])), [days]);
  const months = useMemo(() => days.map((day) => day.day.slice(0, 7)).filter((key, index, all) => all.indexOf(key) === index), [days]);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/availability');
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || 'The calendar is unavailable.');
      const next: Day[] = body.days || [];
      setDays(next);
      setHours(body.availabilityLabel || '');
      setMonth((current) => current || (next[0] ? next[0].day.slice(0, 7) : ''));
    } catch (err: any) {
      setError(err.message || 'The calendar is unavailable.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openDay = (day: Day) => {
    setActiveDay(day.day);
    setNotice('');
    setError('');
    if (selected && selected.day.day !== day.day) setSelected(null);
    window.requestAnimationFrame(() => {
      document.querySelector('.rwr-book-hours')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const choose = (day: Day, slot: Slot) => {
    setSelected({ day, slot });
    setNotice('');
    setError('');
    window.requestAnimationFrame(() => {
      document.querySelector('.rwr-book-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, phone, startsAt: selected.slot.startsAt }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || 'Could not send the request.');
      setNotice(body.notice || 'Request sent.');
      setSelected(null);
      setActiveDay('');
      setName('');
      setEmail('');
      setPhone('');
      await load();
    } catch (err: any) {
      setError(err.message || 'Could not send the request.');
    } finally {
      setSaving(false);
    }
  };

  const [yearText, monthText] = (month || '2026-10').split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const monthLabel = new Date(year, monthIndex, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const monthAt = months.indexOf(month);
  const opened = byDay.get(activeDay);
  const openedParts = opened ? splitDay(opened.label) : null;
  const when = selected ? `${splitDay(selected.day.label).weekday}, ${splitDay(selected.day.label).rest} · ${selected.slot.label}` : '';

  return (
    <div className="rwr-book">
      <Header />
      <main className="rwr-book-main">
        <div className="rwr-container">
          <header className="rwr-book-head">
            <span className="rwr-eyebrow">Book a session</span>
            <h1>Pick a day.</h1>
            <p className="rwr-lead">
              {hours || 'Monday through Friday, 9 AM to 5 PM Eastern'}. Choose a day, then an open hour. If Rachel accepts, she will be in touch to schedule a phone call.
            </p>
          </header>

          {error && !selected && <p className="rwr-book-error">{error}</p>}

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
                    {WEEKDAYS.map((name) => <span key={name}>{name}</span>)}
                  </div>
                  <div className="rwr-cal-grid">
                    {monthCells(year, monthIndex).map((cell) => {
                      if (!cell.iso || cell.date === null) return <span key={cell.key} className="is-pad" />;
                      const day = byDay.get(cell.iso);
                      const openCount = day?.slots.filter((slot) => slot.status === 'open').length || 0;
                      const picked = activeDay === cell.iso;
                      if (!day) {
                        return <span key={cell.key} className="is-off">{cell.date}</span>;
                      }
                      return (
                        <button
                          key={cell.key}
                          type="button"
                          className={picked ? 'is-picked' : 'is-on'}
                          aria-pressed={picked}
                          aria-label={`${day.label}${openCount ? `, ${openCount} open` : ', full'}`}
                          onClick={() => openDay(day)}
                        >
                          {cell.date}
                          {openCount > 0 && <i className="dot" />}
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              {opened && openedParts && (
                <section className="rwr-book-hours">
                  <header>
                    <h2>{openedParts.weekday}</h2>
                    <span>{openedParts.rest}</span>
                  </header>
                  <p>9 AM to 5 PM</p>
                  <div className="rwr-book-slots">
                    {opened.slots.map((slot) => {
                      const open = slot.status === 'open';
                      const isSelected = selected?.slot.startsAt === slot.startsAt;
                      return (
                        <button
                          key={slot.startsAt}
                          type="button"
                          className={isSelected ? 'is-selected' : open ? 'is-open' : 'is-taken'}
                          disabled={!open}
                          aria-pressed={isSelected}
                          onClick={() => choose(opened, slot)}
                        >
                          <strong>{slot.label}</strong>
                          <span>{isSelected ? 'Selected' : open ? 'Open' : 'Taken'}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>

            <aside className="rwr-book-panel">
              {notice ? (
                <div className="rwr-book-success">
                  <span className="check" aria-hidden="true">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </span>
                  <h2>Request sent</h2>
                  <p>{notice}</p>
                </div>
              ) : selected ? (
                <form onSubmit={submit}>
                  <p className="rwr-book-when">{when}</p>
                  <h2>Request this hour</h2>
                  <p className="sub">Rachel will accept or deny it, then follow up about a phone call.</p>
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
                </form>
              ) : (
                <div className="rwr-book-empty">
                  <span className="mark" aria-hidden="true">RR</span>
                  <h2>{opened ? 'Choose an hour' : 'Choose a day'}</h2>
                  <p>{opened ? 'Pick an open hour for this day.' : 'Weekdays with a mark still have an open hour between 9 AM and 5 PM.'}</p>
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
