/* US Political Tracker — intro links + one county choropleth (Leaflet).
   Layers: 287g (quarterly, cumulative), ccc (quarterly events), president (election years).
   Frames always come from data.meta.quarters (alias meta.frames) — no hard-coded years. */
(function () {
  "use strict";
  const cfg = window.MAP_CONFIG;
  if (!cfg || !cfg.layers) return;

  const $ = (id) => document.getElementById(id);
  const statusEl = $("mapStatus");
  const slider = $("frameSlider");
  const frameLabel = $("frameLabel");
  const playBtn = $("playBtn");
  const modeBtns = Array.from(document.querySelectorAll(".toggle button"));
  const layerLinks = Array.from(document.querySelectorAll(".layer-link"));

  function showStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.innerHTML = msg;
    statusEl.classList.toggle("error", !!isError);
    statusEl.hidden = false;
  }
  function hideStatus() {
    if (statusEl) statusEl.hidden = true;
  }
  const SERVE_HINT =
    "Serve this folder over HTTP instead of opening the file directly:<br>" +
    "<code>python3 -m http.server 8765</code> → <code>http://127.0.0.1:8765/</code>";

  if (location.protocol === "file:") {
    showStatus("Map data can’t load from a <code>file://</code> page.<br>" + SERVE_HINT, true);
    return;
  }
  if (!window.L) {
    showStatus("Map library (Leaflet, unpkg.com) failed to load. Check the network connection and reload.", true);
    return;
  }

  /* ---------------- Palettes ---------------- */
  const NONE = "#eceae4";
  const MODE_COLORS = { 1: "#6baed6", 2: "#2171b5", 3: "#08306b" }; // WSO < TFM < JEM
  const BINARY_ON = "#2171b5";
  const CCC_COLORS = ["#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#08519c", "#08306b"];
  const CCC_LABELS = ["1", "2–4", "5–9", "10–24", "25–49", "50–99", "100+"];
  // Presidential two-party margin: symmetric bins |m| in [0,5), [5,15), [15,30), [30,∞); muted blue/red.
  const PRES_EDGES = [5, 15, 30];
  const PRES_D = ["#e4eaf1", "#c3d1e2", "#9fb4cd", "#7d97b8"]; // D+0–5 … D+30+
  const PRES_R = ["#f4e7e4", "#e6c4bd", "#d6a69c", "#c48a7e"]; // R+0–5 … R+30+
  const PRES_TIE = "#e3ded4";
  const WIN_COLORS = { 1: "#8aa5c4", 2: "#cf9488" };
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);

  /* Per-layer UI text. */
  const LAYER_UI = {
    "287g": { modes: { continuous: "Intensity", binary: "Any / none" }, frameNoun: "Quarter", playMs: 900 },
    ccc: { modes: { continuous: "Intensity", binary: "Any / none" }, frameNoun: "Quarter", playMs: 900 },
    president: { modes: { continuous: "Margin", binary: "Winner" }, frameNoun: "Election year", playMs: 1400 },
  };

  /* ---------------- State ---------------- */
  let kind = null; // currently displayed layer key
  let data = null; // its JSON
  let mode = "continuous";
  let frameIdx = 0;
  let playTimer = null;
  let reqSeq = 0;
  let geoLayer = null;
  let hovered = null;
  let geoPromise = null;
  const dataCache = new Map(); // key -> Promise<json>

  const US48 = L.latLngBounds([24.3, -125.0], [49.5, -66.8]);
  const map = L.map("map", {
    zoomControl: true,
    attributionControl: false,
    scrollWheelZoom: false, // enabled after the user clicks the map (avoids scroll-jacking the page)
    zoomSnap: 0.1,
    zoomDelta: 0.5,
    minZoom: 2,
    maxBounds: US48.pad(0.6),
    maxBoundsViscosity: 0.8,
    renderer: L.canvas({ padding: 0.3 }),
  });
  let userMoved = false;
  let programmatic = false;
  function fitUS() {
    programmatic = true;
    map.fitBounds(geoLayer ? geoLayer.getBounds() : US48, { padding: [4, 4], animate: false });
    programmatic = false;
  }
  fitUS();
  map.on("dragstart", () => { userMoved = true; });
  map.on("zoomstart", () => { if (!programmatic) userMoved = true; });
  map.on("click", () => map.scrollWheelZoom.enable());
  map.on("mouseout", () => map.scrollWheelZoom.disable());
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      map.invalidateSize();
      if (!userMoved) fitUS();
    }, 150);
  });

  /* ---------------- Helpers ---------------- */
  function frames() {
    return (data && data.meta && (data.meta.quarters || data.meta.frames)) || [];
  }
  function currentFrame() {
    return frames()[frameIdx];
  }
  function series() {
    return (data && data.series && data.series[currentFrame()]) || {};
  }
  function ui() {
    return LAYER_UI[kind] || LAYER_UI["287g"];
  }
  function quarterEnd(q) {
    const m = /^(\d{4})-Q([1-4])$/.exec(q || "");
    return m ? new Date(Date.UTC(+m[1], +m[2] * 3, 0)) : null;
  }
  function frameText(f) {
    if (kind === "287g" && data.meta.snapshot) {
      const end = quarterEnd(f);
      const snap = new Date(data.meta.snapshot + "T00:00:00Z");
      if (end && snap < end) return f + " (to " + data.meta.snapshot + ")";
    }
    return f;
  }
  function cccBin(n) {
    if (!n || n <= 0) return -1;
    if (n < 2) return 0;
    if (n < 5) return 1;
    if (n < 10) return 2;
    if (n < 25) return 3;
    if (n < 50) return 4;
    if (n < 100) return 5;
    return 6;
  }
  function presBin(m) {
    const a = Math.abs(m);
    let i = 0;
    while (i < PRES_EDGES.length && a >= PRES_EDGES[i]) i++;
    return i;
  }
  function fmtMargin(m) {
    if (m === 0) return "Tie";
    return (m < 0 ? "D+" : "R+") + Math.abs(m).toFixed(1);
  }

  function colorFor(id) {
    if (!data) return NONE;
    const s = series();
    if (kind === "287g") {
      const m = s.mode && s.mode[id];
      if (mode === "binary") return m ? BINARY_ON : NONE;
      return (m && MODE_COLORS[m]) || NONE;
    }
    if (kind === "ccc") {
      const n = (s.count && s.count[id]) || 0;
      if (mode === "binary") return n > 0 ? BINARY_ON : NONE;
      const bi = cccBin(n);
      return bi < 0 ? NONE : CCC_COLORS[bi];
    }
    // president
    const m = s.margin ? s.margin[id] : undefined;
    if (m === undefined || m === null) return NONE;
    if (mode === "binary") {
      const w = s.winner && s.winner[id];
      return WIN_COLORS[w] || PRES_TIE;
    }
    if (m === 0) return PRES_TIE;
    return (m < 0 ? PRES_D : PRES_R)[presBin(m)];
  }

  function tooltipHtml(props) {
    const id = props.id;
    const label = esc(props.name || id) + (props.st ? ", " + esc(props.st) : "");
    if (!data) return `<strong>${label}</strong>`;
    const f = currentFrame();
    const s = series();
    if (kind === "287g") {
      const m = s.mode && s.mode[id];
      const c = (s.count && s.count[id]) || 0;
      if (!m) return `<strong>${label}</strong><br>No agreement by end of ${esc(f)}`;
      const names = data.meta.mode_codes || {};
      return (
        `<strong>${label}</strong><br>${esc(names[String(m)] || "Model " + m)}` +
        `<br>${c} agreement${c === 1 ? "" : "s"} by end of ${esc(f)}`
      );
    }
    if (kind === "ccc") {
      const n = (s.count && s.count[id]) || 0;
      return `<strong>${label}</strong><br>${n} event${n === 1 ? "" : "s"} in ${esc(f)}`;
    }
    const m = s.margin ? s.margin[id] : undefined;
    if (m === undefined || m === null) {
      const ct = String(id).slice(0, 2) === "09";
      return (
        `<strong>${label}</strong><br>${esc(f)}: no county result` +
        (ct ? "<br><span class='tt-note'>Results reported for CT’s 8 former counties; map uses 2022 planning regions</span>" : "")
      );
    }
    const w = s.winner && s.winner[id];
    const wName = (data.meta.winner_codes || {})[String(w)] || "";
    const tot = s.total && s.total[id];
    return (
      `<strong>${label}</strong><br>${esc(f)}: ${fmtMargin(m)} (two-party)` +
      (wName ? `<br>Winner: ${esc(wName)}` : "") +
      (tot ? `<br>${Number(tot).toLocaleString("en-US")} total votes` : "")
    );
  }

  function styleFor(feature) {
    return {
      fillColor: colorFor(feature.properties.id),
      weight: 0.35,
      color: "#fcfbf8",
      fillOpacity: 1,
      opacity: 1,
    };
  }

  function onEachFeature(feature, lyr) {
    lyr.bindTooltip(() => tooltipHtml(feature.properties), { sticky: true, opacity: 0.97 });
    lyr.on({
      mouseover: (e) => {
        hovered = e.target;
        e.target.setStyle({ weight: 1.2, color: "#2b2a28" });
        e.target.bringToFront();
      },
      mouseout: (e) => {
        if (hovered === e.target) hovered = null;
        e.target.setStyle(styleFor(e.target.feature));
      },
    });
  }

  /* ---------------- Rendering ---------------- */
  function refreshColors() {
    if (geoLayer) {
      geoLayer.eachLayer((lyr) => {
        const st = styleFor(lyr.feature);
        if (lyr === hovered) {
          st.weight = 1.2;
          st.color = "#2b2a28";
        }
        lyr.setStyle(st);
      });
      if (hovered && hovered.isTooltipOpen && hovered.isTooltipOpen()) hovered.getTooltip().update();
    }
    renderLegend();
  }

  function sw(color, text) {
    return `<span class="item"><i class="swatch" style="background:${color}"></i>${esc(text)}</span>`;
  }

  function renderLegend() {
    const el = $("legend");
    if (!el || !data) return;
    let title = "";
    let items = "";
    if (kind === "287g") {
      if (mode === "binary") {
        title = "287(g) agreement:";
        items = sw(BINARY_ON, "Any") + sw(NONE, "None");
      } else {
        title = "Highest 287(g) model:";
        items =
          sw(NONE, "None") +
          sw(MODE_COLORS[1], "Warrant Service Officer") +
          sw(MODE_COLORS[2], "Task Force") +
          sw(MODE_COLORS[3], "Jail Enforcement");
      }
    } else if (kind === "ccc") {
      if (mode === "binary") {
        title = "Protest events in quarter:";
        items = sw(BINARY_ON, "Any") + sw(NONE, "None");
      } else {
        title = "Protest events in quarter:";
        const labels = data.meta.bin_labels || CCC_LABELS;
        items = sw(NONE, "0");
        for (let i = 0; i < CCC_COLORS.length; i++) items += sw(CCC_COLORS[i], labels[i] || CCC_LABELS[i]);
      }
    } else if (mode === "binary") {
      title = "County winner:";
      items = sw(WIN_COLORS[1], "Democratic") + sw(WIN_COLORS[2], "Republican") + sw(NONE, "No data");
    } else {
      title = "Two-party margin (pp):";
      const rng = ["0–5", "5–15", "15–30", "30+"];
      for (let i = 3; i >= 0; i--) items += sw(PRES_D[i], "D+" + rng[i]);
      for (let i = 0; i < 4; i++) items += sw(PRES_R[i], "R+" + rng[i]);
      items += sw(NONE, "No data");
    }
    el.innerHTML = `<span class="legend-title">${esc(title)}</span>${items}`;
  }

  function renderSource() {
    const el = $("source");
    if (!el || !data) return;
    const tail = " Alaska and Hawaii not shown.";
    let html = "";
    if (kind === "287g") {
      const snap = esc(data.meta.snapshot || "2026-10-08");
      html =
        `Source: ICE 287(g) Participating Entities, as of ${snap}. ` +
        "Cumulative through quarter-end by signed date; official terminations not reflected." + tail;
    } else if (kind === "ccc") {
      html =
        "Source: Crowd Counting Consortium Phase 3, Harvard Dataverse, " +
        '<a href="https://doi.org/10.7910/DVN/RI9JFU" target="_blank" rel="noopener">doi:10.7910/DVN/RI9JFU</a> (CC0). ' +
        "Events within each quarter (not cumulative)." + tail;
    } else {
      html =
        "Source: MIT Election Data and Science Lab, County Presidential Election Returns 2000–2024 (Harvard Dataverse), " +
        '<a href="https://doi.org/10.7910/DVN/VOQCHQ" target="_blank" rel="noopener">doi:10.7910/DVN/VOQCHQ</a>. ' +
        "Margin = 100×(R−D)/(R+D), two-party, percentage points; positive = Republican lead. " +
        "Connecticut shown as no data: results are reported for its 8 former counties, while the map uses the 9 planning regions adopted in 2022." +
        tail;
    }
    el.innerHTML = html;
  }

  function setFrame(i) {
    const fr = frames();
    frameIdx = Math.max(0, Math.min(fr.length - 1, i));
    const txt = frameText(currentFrame());
    frameLabel.textContent = txt;
    slider.value = String(frameIdx);
    slider.setAttribute("aria-valuetext", txt);
    refreshColors();
  }

  function setMode(m) {
    mode = m === "binary" ? "binary" : "continuous";
    modeBtns.forEach((btn) => {
      const on = btn.dataset.mode === mode;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    refreshColors();
  }

  function stopPlay() {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    playBtn.textContent = "Play";
    playBtn.setAttribute("aria-pressed", "false");
  }

  function togglePlay() {
    if (playTimer) return stopPlay();
    const n = frames().length;
    if (n < 2) return;
    if (frameIdx >= n - 1) setFrame(0);
    playBtn.textContent = "Pause";
    playBtn.setAttribute("aria-pressed", "true");
    playTimer = setInterval(() => {
      setFrame(frameIdx >= frames().length - 1 ? 0 : frameIdx + 1);
    }, ui().playMs);
  }

  function highlightLinks(key) {
    layerLinks.forEach((a) => {
      const on = a.dataset.layer === key;
      a.classList.toggle("current", on);
      if (on) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    });
  }

  function applyLayer() {
    const u = ui();
    const fr = frames();
    modeBtns.forEach((btn) => { btn.textContent = u.modes[btn.dataset.mode]; });
    mode = "continuous"; // each layer opens in its default mode
    modeBtns.forEach((btn) => {
      const on = btn.dataset.mode === mode;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    slider.min = "0";
    slider.max = String(Math.max(0, fr.length - 1));
    slider.disabled = fr.length < 2;
    slider.setAttribute("aria-label", u.frameNoun);
    playBtn.disabled = fr.length < 2;
    document.title = cfg.layers[kind].title + " | US Political Tracker | Erdong Xu";
    highlightLinks(kind);
    renderSource();
    setFrame(fr.length - 1); // latest frame; also recolors + legend
  }

  /* ---------------- Loading ---------------- */
  async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ": HTTP " + r.status);
    return r.json();
  }
  function ensureGeo() {
    if (!geoPromise) {
      geoPromise = fetchJSON(cfg.geojson).then((geo) => {
        geoLayer = L.geoJSON(geo, { style: styleFor, onEachFeature }).addTo(map);
        if (!userMoved) fitUS();
        return geoLayer;
      });
      geoPromise.catch(() => { geoPromise = null; });
    }
    return geoPromise;
  }
  function getData(key) {
    if (!dataCache.has(key)) {
      const p = fetchJSON(cfg.layers[key].data);
      dataCache.set(key, p);
      p.catch(() => dataCache.delete(key));
    }
    return dataCache.get(key);
  }

  function normalizeKey(raw) {
    const k = String(raw || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (cfg.layers[k]) return k;
    if (k === "287" || k === "ice") return "287g";
    if (k === "pres" || k === "election" || k === "elections") return "president";
    return cfg.defaultLayer || Object.keys(cfg.layers)[0];
  }
  function layerFromURL() {
    const p = new URLSearchParams(location.search);
    return normalizeKey(p.get("layer") || (location.hash || "").replace(/^#/, ""));
  }
  function updateURL(how) {
    if (how === "none") return;
    const url = new URL(location.href);
    url.searchParams.set("layer", kind);
    url.hash = "";
    if (url.href === location.href) return;
    if (how === "push") history.pushState({ layer: kind }, "", url.href);
    else history.replaceState({ layer: kind }, "", url.href);
  }

  async function loadLayer(rawKey, how) {
    const key = normalizeKey(rawKey);
    stopPlay();
    highlightLinks(key);
    if (key === kind && data) {
      updateURL(how);
      return;
    }
    const seq = ++reqSeq;
    const slow = setTimeout(() => { if (seq === reqSeq) showStatus("Loading map…"); }, geoLayer ? 150 : 0);
    try {
      const [, d] = await Promise.all([ensureGeo(), getData(key)]);
      if (seq !== reqSeq) return; // a newer click won
      kind = key;
      data = d;
      applyLayer();
      updateURL(how);
      hideStatus();
    } catch (err) {
      if (seq !== reqSeq) return;
      if (kind) highlightLinks(kind);
      showStatus("Failed to load map data (" + esc(err && err.message ? err.message : err) + ").<br>" + SERVE_HINT, true);
    } finally {
      clearTimeout(slow);
    }
  }

  /* ---------------- Wiring ---------------- */
  slider.addEventListener("input", (e) => {
    stopPlay();
    setFrame(parseInt(e.target.value, 10));
  });
  modeBtns.forEach((btn) => btn.addEventListener("click", () => setMode(btn.dataset.mode)));
  playBtn.addEventListener("click", togglePlay);

  layerLinks.forEach((a) =>
    a.addEventListener("click", (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab etc.
      e.preventDefault();
      loadLayer(a.dataset.layer, "push");
      const panel = document.querySelector(".map-panel");
      if (panel) {
        const r = panel.getBoundingClientRect();
        if (r.top > window.innerHeight * 0.6) panel.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    })
  );
  window.addEventListener("popstate", () => loadLayer(layerFromURL(), "none"));
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopPlay(); });

  loadLayer(layerFromURL(), "replace");
})();
