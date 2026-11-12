export default function Cta() {
  return (
    <section className="cta-section">
      <div className="section-wrap">
        <div className="container-2nd">
          <div className="cta-wrapper">
            <div scale-up="True" className="cta-banner-box">
              <img sizes="100vw" srcSet="/assets/6a93c65c838ecd2fa17f58c0_cta_banner_p_500.avif 500w, /assets/6a93c65c838ecd2fa17f58c0_cta_banner_p_800.avif 800w, /assets/6a93c65c838ecd2fa17f58c0_cta_banner_p_1080.avif 1080w, /assets/6a93c65c838ecd2fa17f58c0_cta_banner.avif 1380w" alt="Banner" src="/assets/6a93c65c838ecd2fa17f58c0_cta_banner.avif" loading="lazy" className="cta-banner" />
            </div>
            <div fade-anim="True" className="cta-title-box">
              <h2 className="cta-title">
                Stop paying twice for the same job.
              </h2>
            </div>
            <div fade-anim="True" className="cta-newsletter-wrap">
              <div className="cta-newsletter-title">
                GET STARTED
              </div>
              <div className="cta-newsletter-box">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                <a data-wf--primary-button--variant="main-button" href="/near" className="primary-button w-inline-block">
                  <div className="primary-button-text-items"><div className="primary-button-text-wrap">
                    <div className="primary-button-text one">SEE LIVE STATE</div>
                    <div className="primary-button-text two">SEE LIVE STATE</div>
                  </div></div>
                  <div className="primary-button-icon-wrap">
                    <div className="primary-button-icon-box"><img src="/assets/6a940bdd07117569c26e60b8_btn_icon.svg" loading="lazy" alt="Icon" className="primary-button-icon" /></div>
                    <div className="primary-button-icon-box"><img src="/assets/6a940df507117569c26eab94_btn_icon_2.svg" loading="lazy" alt="Icon" className="primary-button-icon" /></div>
                    <div className="primary-button-icon-box two"><img src="/assets/6a9d5d892f159f58a1b00821_btn_icon_3.svg" loading="lazy" alt="Icon" className="primary-button-icon" /></div>
                    <div className="primary-button-icon-box two"><img src="/assets/6a9d5d88f0c4f20f0444af57_btn_icon_4.svg" loading="lazy" alt="Icon" className="primary-button-icon" /></div>
                  </div>
                </a>
                <a data-wf--primary-button--variant="main-button" href="https://github.com/hackerjose25/Phoebe-NEARHack/blob/main/docs/proof-near.md" className="primary-button w-inline-block">
                  <div className="primary-button-text-items"><div className="primary-button-text-wrap">
                    <div className="primary-button-text one">READ THE PROOF</div>
                    <div className="primary-button-text two">READ THE PROOF</div>
                  </div></div>
                  <div className="primary-button-icon-wrap">
                    <div className="primary-button-icon-box"><img src="/assets/6a940bdd07117569c26e60b8_btn_icon.svg" loading="lazy" alt="Icon" className="primary-button-icon" /></div>
                    <div className="primary-button-icon-box"><img src="/assets/6a940df507117569c26eab94_btn_icon_2.svg" loading="lazy" alt="Icon" className="primary-button-icon" /></div>
                    <div className="primary-button-icon-box two"><img src="/assets/6a9d5d892f159f58a1b00821_btn_icon_3.svg" loading="lazy" alt="Icon" className="primary-button-icon" /></div>
                    <div className="primary-button-icon-box two"><img src="/assets/6a9d5d88f0c4f20f0444af57_btn_icon_4.svg" loading="lazy" alt="Icon" className="primary-button-icon" /></div>
                  </div>
                </a>
                </div>
                <p className="cta-newsletter-text">
                  Three agents, one job, one payment on NEAR testnet. See the live contract state, or read the proof.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
