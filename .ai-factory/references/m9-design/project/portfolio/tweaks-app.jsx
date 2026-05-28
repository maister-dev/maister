/* ═══════════════════════════════════════════════════════════════
   MAIster · Portfolio home · Tweaks panel
   Density · Layout · Tile content · Project count · Palette · Theme
   ═══════════════════════════════════════════════════════════════ */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette":      "forest",
  "theme":        "auto",
  "density":      "comfy",
  "state":        "populated",
  "projectCount": 3,
  "showTeam":     true,
  "showNeeds":    true,
  "showFoot":     true,
  "showConfig":   true,
  "showRecent":   true,
  "showDesc":     true,
  "showTicker":   true
}/*EDITMODE-END*/;

const PALETTE_SWATCHES = {
  amber:  ['#e2602e', '#2a6fd6', '#7a5ae0'],
  forest: ['#588157', '#3a5a40', '#a3b18a'],
  jade:   ['#2dc653', '#1a7431', '#6ede8a'],
  slate:  ['#1d1f22', '#4a4e55', '#d0d0cc']
};

function PortfolioTweaks(){
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // wire up the global setters
  React.useEffect(() => { if(window.MaisterSetPalette) window.MaisterSetPalette(t.palette); }, [t.palette]);
  React.useEffect(() => {
    if(!window.MaisterSetTheme) return;
    if(t.theme === 'auto'){
      const sys = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      window.MaisterSetTheme(sys);
    } else { window.MaisterSetTheme(t.theme); }
  }, [t.theme]);
  React.useEffect(() => { if(window.MaisterSetDensity)      window.MaisterSetDensity(t.density);              }, [t.density]);
  React.useEffect(() => { if(window.MaisterSetState)        window.MaisterSetState(t.state);                  }, [t.state]);
  React.useEffect(() => { if(window.MaisterSetProjectCount) window.MaisterSetProjectCount(t.projectCount);    }, [t.projectCount]);
  React.useEffect(() => { if(window.MaisterSetTileFeature)  window.MaisterSetTileFeature('team',   t.showTeam);    }, [t.showTeam]);
  React.useEffect(() => { if(window.MaisterSetTileFeature)  window.MaisterSetTileFeature('needs',  t.showNeeds);   }, [t.showNeeds]);
  React.useEffect(() => { if(window.MaisterSetTileFeature)  window.MaisterSetTileFeature('foot',   t.showFoot);    }, [t.showFoot]);
  React.useEffect(() => { if(window.MaisterSetTileFeature)  window.MaisterSetTileFeature('config', t.showConfig);  }, [t.showConfig]);
  React.useEffect(() => { if(window.MaisterSetTileFeature)  window.MaisterSetTileFeature('recent', t.showRecent);  }, [t.showRecent]);
  React.useEffect(() => { if(window.MaisterSetTileFeature)  window.MaisterSetTileFeature('desc',   t.showDesc);    }, [t.showDesc]);
  React.useEffect(() => { if(window.MaisterSetTileFeature)  window.MaisterSetTileFeature('ticker', t.showTicker);  }, [t.showTicker]);

  return (
    <TweaksPanel title="Tweaks · Portfolio">

      {/* ── canvas state ───────────────────────────────────── */}
      <TweakSection label="State" />
      <TweakRadio
        label="Canvas"
        value={t.state}
        options={['populated', 'empty']}
        onChange={(v) => setTweak('state', v)}
      />

      {/* ── layout / density ───────────────────────────────── */}
      <TweakSection label="Layout" />
      <TweakRadio
        label="Density"
        value={t.density}
        options={['comfy', 'compact', 'list']}
        onChange={(v) => setTweak('density', v)}
      />
      <TweakSlider
        label="Projects shown"
        value={t.projectCount}
        min={3} max={6} step={1}
        onChange={(v) => setTweak('projectCount', v)}
      />

      {/* ── tile content toggles ───────────────────────────── */}
      <TweakSection label="Tile content" />
      <TweakToggle label="Project description" value={t.showDesc}   onChange={(v) => setTweak('showDesc',   v)} />
      <TweakToggle label="Team & avatars"      value={t.showTeam}   onChange={(v) => setTweak('showTeam',   v)} />
      <TweakToggle label="Config row (agent/flow/mcps)" value={t.showConfig} onChange={(v) => setTweak('showConfig', v)} />
      <TweakToggle label="Needs-you callout"   value={t.showNeeds}  onChange={(v) => setTweak('showNeeds',  v)} />
      <TweakToggle label="Recently merged"     value={t.showRecent} onChange={(v) => setTweak('showRecent', v)} />
      <TweakToggle label="Tags & backlog"      value={t.showFoot}   onChange={(v) => setTweak('showFoot',   v)} />
      <TweakToggle label="Live ticker"         value={t.showTicker} onChange={(v) => setTweak('showTicker', v)} />

      {/* ── surface ────────────────────────────────────────── */}
      <TweakSection label="Palette" />
      <TweakColor
        label="Brand palette"
        value={PALETTE_SWATCHES[t.palette] || PALETTE_SWATCHES.forest}
        options={[PALETTE_SWATCHES.amber, PALETTE_SWATCHES.forest, PALETTE_SWATCHES.jade, PALETTE_SWATCHES.slate]}
        onChange={(arr) => {
          const key = Object.keys(PALETTE_SWATCHES).find(k =>
            PALETTE_SWATCHES[k].every((c,i) => c.toLowerCase() === (arr[i]||'').toLowerCase())
          ) || 'forest';
          setTweak('palette', key);
        }}
      />

      <TweakSection label="Surface" />
      <TweakRadio
        label="Theme"
        value={t.theme}
        options={['light', 'dark', 'auto']}
        onChange={(v) => setTweak('theme', v)}
      />

    </TweaksPanel>
  );
}

const __mount = document.createElement('div');
__mount.id = '__maister_portfolio_tweaks_mount';
document.body.appendChild(__mount);
ReactDOM.createRoot(__mount).render(<PortfolioTweaks />);
