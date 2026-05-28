/* ═══════════════════════════════════════════════════════════════
   MAIster · Landing · Tweaks panel
   Three expressive controls (palette, vibe, hero mode) + utility.
   Hooks the global MaisterSet* setters exposed by 02-hifi.js.
   ═══════════════════════════════════════════════════════════════ */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette": "forest",
  "vibe":    "editorial",
  "heroMode":"spine",
  "theme":   "auto",
  "lang":    "en",
  "wordmark":"lower",
  "logo":     0,
  "headline":"b",
  "authLayout":"split-spine"
}/*EDITMODE-END*/;

// fully-curated palette swatch arrays so TweakColor renders the trio per palette
const PALETTE_SWATCHES = {
  amber:   ['#e2602e', '#2a6fd6', '#7a5ae0'],
  forest:  ['#588157', '#3a5a40', '#a3b18a'],
  jade:    ['#2dc653', '#1a7431', '#6ede8a'],
  slate:   ['#1d1f22', '#4a4e55', '#d0d0cc']
};

function MaisterTweaks(){
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // apply each tweak through the global setters
  React.useEffect(() => { if(window.MaisterSetPalette)  window.MaisterSetPalette(t.palette);   }, [t.palette]);
  React.useEffect(() => { if(window.MaisterSetVibe)     window.MaisterSetVibe(t.vibe);         }, [t.vibe]);
  React.useEffect(() => { if(window.MaisterSetHeroMode) window.MaisterSetHeroMode(t.heroMode); }, [t.heroMode]);
  React.useEffect(() => {
    if(!window.MaisterSetTheme) return;
    if(t.theme === 'auto'){
      const sys = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      window.MaisterSetTheme(sys);
    } else { window.MaisterSetTheme(t.theme); }
  }, [t.theme]);
  React.useEffect(() => { if(window.MaisterSetLang)     window.MaisterSetLang(t.lang);         }, [t.lang]);
  React.useEffect(() => { if(window.MaisterSetWordmark) window.MaisterSetWordmark(t.wordmark); }, [t.wordmark]);
  React.useEffect(() => { if(window.MaisterSetLogo)     window.MaisterSetLogo(t.logo);         }, [t.logo]);
  React.useEffect(() => { if(window.MaisterSetHeadline) window.MaisterSetHeadline(t.headline); }, [t.headline, t.lang]);
  React.useEffect(() => { if(window.MaisterSetAuthLayout) window.MaisterSetAuthLayout(t.authLayout); }, [t.authLayout]);

  // detect whether we're on the auth screen — show Auth-only tweak section
  const isAuthScreen = !!document.querySelector('.auth-page');

  return (
    <TweaksPanel title="Tweaks · MAIster">

      {/* ─── EXPRESSIVE · the three "reshape the feel" controls ── */}
      <TweakSection label="Palette" />
      <TweakColor
        label="Brand palette"
        value={PALETTE_SWATCHES[t.palette] || PALETTE_SWATCHES.amber}
        options={[PALETTE_SWATCHES.amber, PALETTE_SWATCHES.forest, PALETTE_SWATCHES.jade, PALETTE_SWATCHES.slate]}
        onChange={(arr) => {
          const key = Object.keys(PALETTE_SWATCHES).find(k =>
            PALETTE_SWATCHES[k].every((c,i) => c.toLowerCase() === (arr[i]||'').toLowerCase())
          ) || 'amber';
          setTweak('palette', key);
        }}
      />

      <TweakSection label="Vibe" />
      <TweakRadio
        label="Type & shape stance"
        value={t.vibe}
        options={['editorial','operator','brutal']}
        onChange={(v) => setTweak('vibe', v)}
      />

      <TweakSection label="Hero" />
      <TweakRadio
        label="Stage content"
        value={t.heroMode}
        options={['spine','ui','terminal']}
        onChange={(v) => setTweak('heroMode', v)}
      />
      <TweakRadio
        label="Headline copy"
        value={t.headline}
        options={['a','b','c']}
        onChange={(v) => setTweak('headline', v)}
      />

      {isAuthScreen && (
        <React.Fragment>
          <TweakSection label="Auth screen" />
          <TweakSelect
            label="Layout"
            value={t.authLayout}
            options={[
              { value:'centered',        label:'Centered (minimal)' },
              { value:'split-spine',     label:'Split · Spine diagram' },
              { value:'split-instance',  label:'Split · Live instance' },
              { value:'split-quote',     label:'Split · Quote' }
            ]}
            onChange={(v) => setTweak('authLayout', v)}
          />
        </React.Fragment>
      )}

      {/* ─── UTILITY ────────────────────────────────────────── */}
      <TweakSection label="Surface" />
      <TweakRadio
        label="Theme"
        value={t.theme}
        options={['light','dark','auto']}
        onChange={(v) => setTweak('theme', v)}
      />
      <TweakRadio
        label="Language"
        value={t.lang}
        options={['en','ru']}
        onChange={(v) => setTweak('lang', v)}
      />

      <TweakSection label="Brand" />
      <TweakRadio
        label="Wordmark"
        value={t.wordmark}
        options={['lower','upper']}
        onChange={(v) => setTweak('wordmark', v)}
      />
      <TweakSelect
        label="Logo mark"
        value={String(t.logo)}
        options={[
          { value: '0', label: 'E1 · loop + AI eyes' },
          { value: '1', label: 'E2 · circuit ring' },
          { value: '2', label: 'E3 · double loop' }
        ]}
        onChange={(v) => setTweak('logo', Number(v))}
      />

    </TweaksPanel>
  );
}

const __mount = document.createElement('div');
__mount.id = '__maister_tweaks_mount';
document.body.appendChild(__mount);
ReactDOM.createRoot(__mount).render(<MaisterTweaks />);
