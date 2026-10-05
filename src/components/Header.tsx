import React, { useEffect, useState } from 'react';

const LINKS = [
  { href: '/#about', label: 'About' },
  { href: '/#services', label: 'Services' },
  { href: '/#experience', label: 'Experience' },
  { href: '/book', label: 'Book' },
  { href: '/#contact', label: 'Contact' },
];

const Header: React.FC = () => {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const navClass = `rwr-nav ${scrolled ? 'is-scrolled' : 'is-top'}`;

  return (
    <header className={navClass}>
      <div className="rwr-container rwr-nav-inner">
        <a className="rwr-brand" href="/" onClick={() => setOpen(false)}>
          <span className="rwr-mark">RR</span>
          Rising&nbsp;with&nbsp;Rachel
        </a>

        <button
          className={`rwr-nav-toggle ${open ? 'is-open' : ''}`}
          aria-label="Toggle menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span />
        </button>

        <nav className={`rwr-nav-links ${open ? 'is-mobile-open' : ''}`}>
          {LINKS.map((l) => (
            <a key={l.href} className="rwr-nav-link" href={l.href} onClick={() => setOpen(false)}>
              {l.label}
            </a>
          ))}
          <a className="rwr-btn rwr-btn--solid rwr-nav-cta" href="#contact" onClick={() => setOpen(false)}>
            Start your journey
          </a>
        </nav>
      </div>
    </header>
  );
};

export default Header;
