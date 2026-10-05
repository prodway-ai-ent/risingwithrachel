import React from 'react';

const Footer: React.FC = () => {
  const year = new Date().getFullYear();
  return (
    <footer className="rwr-footer">
      <div className="rwr-container">
        <div className="rwr-footer-top">
          <div>
            <div className="rwr-footer-brand">
              <span className="rwr-mark">RR</span>
              Rising with Rachel
            </div>
            <p className="rwr-footer-tag">
              Personalized run coaching that meets you at your starting line and carries you to the finish.
            </p>
            <div className="rwr-footer-socials" style={{ marginTop: 20 }}>
              <a href="https://www.instagram.com/rachelontherun_/" target="_blank" rel="noopener noreferrer" aria-label="Instagram">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
                </svg>
              </a>
            </div>
          </div>

          <div className="rwr-footer-cols">
            <div className="rwr-footer-col">
              <h5>Explore</h5>
              <a href="/#about">About</a>
              <a href="/#services">Services</a>
              <a href="/#experience">Experience</a>
              <a href="/book">Book</a>
              <a href="/#contact">Contact</a>
            </div>
            <div className="rwr-footer-col">
              <h5>Get in touch</h5>
              <a href="mailto:hello@risingwithrachel.com">hello@risingwithrachel.com</a>
              <p>Raleigh, North Carolina</p>
              <p>Coaching available nationwide</p>
            </div>
          </div>
        </div>

        <div className="rwr-footer-bottom">
          <span>&copy; {year} Rising with Rachel. All rights reserved.</span>
          <span>risingwithrachel.com</span>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
