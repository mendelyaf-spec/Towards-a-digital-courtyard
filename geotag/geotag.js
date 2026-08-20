// geotag/geotag.js — "where the object lived/lives."
//
// A location is { lat, lng, label, source }. `source` is 'exif' (read
// automatically from a photo), 'device' (the browser's current position), or
// 'manual' (typed in). Used both by pocket items (§pocket.js, before they're
// placed) and by items already on the canvas (via the item bar).
//
// extractExifGPS is pure and dependency-free: it reads just enough of a
// JPEG's EXIF header to pull GPS tags, without decoding the image itself.
// Most photos taken outdoors on a phone already carry this — this is the
// "free" way to know where a leaf or rock was found.

/** Best-effort: returns {lat,lng} from a JPEG's EXIF GPS tags, or null. */
export async function extractExifGPS(file) {
  if (!file || !/jpe?g/i.test(file.type)) return null;
  let buf;
  try {
    buf = await file.slice(0, 256 * 1024).arrayBuffer(); // EXIF lives near the start
  } catch {
    return null;
  }
  const view = new DataView(buf);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // must start with SOI
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) break; // not a marker — stop
    if (marker === 0xffd8 || marker === 0xffd9) { offset += 2; continue; }
    if (marker === 0xffda) break; // start of scan — header section is over
    const segLen = view.getUint16(offset + 2);
    if (marker === 0xffe1 && segLen >= 8) {
      const gps = readExifApp1(view, offset + 4);
      if (gps) return gps;
    }
    offset += 2 + segLen;
  }
  return null;
}

function readExifApp1(view, start) {
  if (start + 6 > view.byteLength) return null;
  if (view.getUint32(start) !== 0x45786966 || view.getUint16(start + 4) !== 0x0000) return null; // "Exif\0\0"
  const tiffStart = start + 6;
  if (tiffStart + 8 > view.byteLength) return null;
  const b0 = view.getUint16(tiffStart);
  const little = b0 === 0x4949;
  if (!little && b0 !== 0x4d4d) return null;
  const g16 = (o) => view.getUint16(o, little);
  const g32 = (o) => view.getUint32(o, little);
  if (g16(tiffStart + 2) !== 42) return null;

  const ifd0 = tiffStart + g32(tiffStart + 4);
  if (ifd0 + 2 > view.byteLength) return null;
  const n0 = g16(ifd0);
  let gpsIfd = null;
  for (let i = 0; i < n0; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > view.byteLength) break;
    if (g16(e) === 0x8825) { gpsIfd = tiffStart + g32(e + 8); break; } // GPSInfo IFD pointer
  }
  if (gpsIfd == null || gpsIfd + 2 > view.byteLength) return null;

  const nG = g16(gpsIfd);
  const tags = {};
  for (let i = 0; i < nG; i++) {
    const e = gpsIfd + 2 + i * 12;
    if (e + 12 > view.byteLength) break;
    const tag = g16(e);
    if (tag === 1 || tag === 3) {
      tags[tag] = String.fromCharCode(view.getUint8(e + 8)); // Ref, stored inline
    } else if (tag === 2 || tag === 4) {
      const valOff = tiffStart + g32(e + 8);
      if (valOff + 24 > view.byteLength) continue;
      const rat = (o) => { const num = g32(o), den = g32(o + 4); return den ? num / den : 0; };
      tags[tag] = rat(valOff) + rat(valOff + 8) / 60 + rat(valOff + 16) / 3600; // deg + min + sec
    }
  }
  if (tags[2] == null || tags[4] == null) return null;
  const lat = tags[1] === "S" ? -tags[2] : tags[2];
  const lng = tags[3] === "W" ? -tags[4] : tags[4];
  if (!isFinite(lat) || !isFinite(lng)) return null;
  return { lat, lng };
}

/** "40.4462, -79.9822" style compact label for a location. */
export function formatCoords(loc) {
  if (!loc) return "";
  return `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`;
}

export function mapsUrl(loc) {
  return `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
}

// ---------------- popover UI ----------------
// A small floating form for viewing/setting/clearing a location. Shared by
// the item bar (placed canvas items) and pocket cards (staged items).
let openPopover = null;

/**
 * Open a geotag popover anchored below `anchorEl`.
 * @param {HTMLElement} anchorEl
 * @param {{lat,lng,label,source}|null} current
 * @param {(loc:object|null)=>void} onChange — called with the new location, or null on clear
 */
export function openGeotagPopover(anchorEl, current, onChange) {
  closeGeotagPopover();

  const pop = document.createElement("div");
  pop.className = "geotag-pop";
  pop.innerHTML = `
    <button type="button" class="geotag-pop__use" data-act="device">📍 use my current location</button>
    <div class="geotag-pop__row">
      <input type="text" class="geotag-pop__lat" placeholder="lat" inputmode="decimal" />
      <input type="text" class="geotag-pop__lng" placeholder="lng" inputmode="decimal" />
    </div>
    <input type="text" class="geotag-pop__label" placeholder="label, e.g. “oak ridge trail”" />
    ${current ? `<p class="geotag-pop__src">from ${current.source === "exif" ? "the photo" : current.source === "device" ? "your location" : "manual entry"}${current.source === "exif" || current.source === "device" ? " — " + formatCoords(current) : ""}</p>` : ""}
    <div class="geotag-pop__actions">
      ${current ? '<button type="button" class="geotag-pop__clear" data-act="clear">clear</button>' : "<span></span>"}
      <button type="button" class="geotag-pop__save" data-act="save">save</button>
    </div>`;
  document.body.appendChild(pop);

  const latInput = pop.querySelector(".geotag-pop__lat");
  const lngInput = pop.querySelector(".geotag-pop__lng");
  const labelInput = pop.querySelector(".geotag-pop__label");
  if (current) {
    latInput.value = current.lat?.toFixed(5) ?? "";
    lngInput.value = current.lng?.toFixed(5) ?? "";
    labelInput.value = current.label || "";
  }

  const r = anchorEl.getBoundingClientRect();
  const popW = pop.offsetWidth || 240;
  const popH = pop.offsetHeight || 160;
  // Prefer opening below the anchor; flip above it if there isn't room
  // (the geo pin sits at an item's top-left, but the item bar's geotag
  // button can be near the bottom toolbar), then clamp fully on-screen.
  let top = r.bottom + 8;
  if (top + popH > window.innerHeight - 8) top = r.top - popH - 8;
  pop.style.left = Math.min(Math.max(r.left, 8), window.innerWidth - popW - 8) + "px";
  pop.style.top = Math.min(Math.max(top, 8), window.innerHeight - popH - 8) + "px";

  pop.querySelector('[data-act="device"]').addEventListener("click", () => {
    if (!navigator.geolocation) { alert("Location isn't available in this browser."); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        latInput.value = pos.coords.latitude.toFixed(5);
        lngInput.value = pos.coords.longitude.toFixed(5);
      },
      () => alert("Couldn't get your location — check location permission."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
  pop.querySelector('[data-act="save"]').addEventListener("click", () => {
    const lat = parseFloat(latInput.value);
    const lng = parseFloat(lngInput.value);
    if (!isFinite(lat) || !isFinite(lng)) { alert("Enter a latitude and longitude, or use your current location."); return; }
    onChange({ lat, lng, label: labelInput.value.trim(), source: current?.source === "exif" ? "exif" : "manual" });
    closeGeotagPopover();
  });
  pop.querySelector('[data-act="clear"]')?.addEventListener("click", () => {
    onChange(null);
    closeGeotagPopover();
  });

  const onOutside = (e) => {
    if (!pop.contains(e.target) && e.target !== anchorEl) closeGeotagPopover();
  };
  setTimeout(() => document.addEventListener("pointerdown", onOutside), 0);
  openPopover = { el: pop, cleanup: () => document.removeEventListener("pointerdown", onOutside) };
}

export function closeGeotagPopover() {
  if (!openPopover) return;
  openPopover.cleanup();
  openPopover.el.remove();
  openPopover = null;
}
