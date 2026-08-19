import type { NamingSettings, NormalizedChannel } from "./models";

const TRANSLIT: Record<string, string> = {
  Å: "A",
  Ä: "A",
  Ö: "O",
  É: "E",
  Ü: "U",
  Ø: "O",
  Æ: "AE",
  å: "a",
  ä: "a",
  ö: "o",
  é: "e",
  ü: "u",
  ø: "o",
  æ: "ae",
};

export function translit(s: string): string {
  return s.replace(/[ÅÄÖÉÜØÆåäöéüøæ]/g, (c) => TRANSLIT[c] ?? c);
}

export function sanitize(s: string, opts: { transliterate: boolean; uppercase: boolean }): string {
  let out = s;
  if (opts.transliterate) out = translit(out);
  // Allow Unicode letters/digits so Å/Ä/Ö (and other latin chars) survive when
  // transliterate is off. \w is ASCII-only and would otherwise strip them.
  out = out.replace(/[^\p{L}\p{N}_-]/gu, "");
  if (opts.uppercase) out = out.toUpperCase();
  return out;
}

function resolveToken(token: string, ch: NormalizedChannel, n: NamingSettings): string {
  switch (token) {
    case "{type}":
      return n.abbreviations.type[ch.type] ?? ch.type;
    case "{network}": {
      if (!ch.network) return n.abbreviations.network[""] ?? "";
      if (n.abbreviations.network[ch.network]) return n.abbreviations.network[ch.network];
      const first = ch.network.split(/[\s/]+/)[0];
      return n.abbreviations.network[first] ?? first;
    }
    case "{band}":
      return n.abbreviations.band[ch.band] ?? ch.band;
    case "{district}":
      // Legacy: raw district value prefixed (e.g. "D6"). Empty for non-SE rows
      // where district is "LA"/"OZ"/"OH6"… so DLA/DOZ never appear. Use {region}
      // instead for region-aware names.
      return ch.district && /^\d+$/.test(ch.district)
        ? `${n.abbreviations.districtPrefix}${ch.district}`
        : "";
    case "{region}":
      // SM6, LA, OZ, OH0, OH6, TF, JW, JX, OY, OX. Empty when unknown.
      return ch.region.countryCode === "unknown" ? "" : ch.region.districtLabel;
    case "{country}":
      // Short ISO-ish code: SE/NO/DK/FI/AX/IS/SJ/FO/GL. Empty when unknown.
      return ch.region.countryCode === "unknown" ? "" : ch.region.countryCode;
    case "{city}": {
      const primary = (ch.city || "").split("/")[0].trim();
      if (!primary) return "";
      const sanitized = sanitize(primary, {
        transliterate: n.transliterate,
        uppercase: n.uppercase,
      });
      return n.cityMaxLength > 0 ? sanitized.slice(0, n.cityMaxLength) : sanitized;
    }
    case "{channel}":
      return ch.channel;
    case "{call}":
      return (ch.call || "").replace(/\//g, "");
    case "{service}":
      return ch.service;
    case "{category}":
      return ch.category;
    case "{label}":
      return ch.label;
    case "{name_hint}":
      return ch.name_hint;
    case "{mode}": {
      const m = ch.mode_effective || "";
      if (!m) return "";
      return n.abbreviations.mode?.[m] ?? m;
    }
    default:
      return "";
  }
}

/**
 * Build name by resolving tokens, sanitizing, dropping empty parts, then joining.
 * Smart join means a leading/trailing/double separator never appears just because
 * one token resolved to an empty string — useful for kanalpaket where city/call
 * are typically empty.
 *
 * Fallback for kanalpaket rader: om den valda mallen producerar en tom sträng
 * faller vi tillbaka på name_hint / channel / label så att raden får ett vettigt
 * default-namn utan att användaren behöver mecka med tokens.
 */
export function buildName(
  ch: NormalizedChannel,
  n: NamingSettings,
  maxLength: number,
): { full: string; clipped: string } {
  const parts = n.components
    .map((t) => resolveToken(t, ch, n))
    .map((p) => sanitize(p, { transliterate: n.transliterate, uppercase: n.uppercase }))
    .filter(Boolean);
  let full = parts.join(n.separator);

  if (!full && ch.source_type === "channel_pack") {
    const fallback = ch.name_hint || ch.channel || ch.label || ch.category || "PACK";
    full = sanitize(fallback, { transliterate: n.transliterate, uppercase: n.uppercase });
  }

  const clipped = maxLength > 0 ? full.slice(0, maxLength) : full;
  return { full, clipped };
}

/**
 * Suffixsekvens: 1, 2, 3… eller A, B, … Z, AA, AB … (bijektiv bas-26) så att
 * sekvensen aldrig tar slut och alltid är deterministisk.
 */
function suffixFor(policy: NamingSettings["collisionPolicy"], attempt: number): string {
  if (policy === "numeric_suffix") return String(attempt);
  let n = attempt;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || "A";
}

/**
 * Bygger ett kandidatnamn som alltid får plats inom `max` tecken.
 * När suffixet ensamt är minst lika långt som `max` behåller vi suffixets
 * svans — det är enda sättet att få unika namn vid t.ex. maxLength=1.
 */
function candidateName(base: string, suffix: string, max: number): string {
  if (!Number.isFinite(max)) return base + suffix;
  if (suffix.length >= max) return suffix.slice(suffix.length - max);
  return base.slice(0, max - suffix.length) + suffix;
}

/**
 * Pure: returns a new `channels` array with `collided` and
 * `generated_name_final` updated for any colliding entries. Input is not
 * mutated.
 *
 * Kollisioner är inte ett exportfel — de löses alltid automatiskt och
 * deterministiskt. Om namnrymden är genuint uttömd (t.ex. maxLength=1 med
 * fler kanaler än tillgängliga tecken) räknas kanalen som olöst och får
 * varningen `unresolved_name_collision`; exporten stoppas inte av oss.
 */
export function resolveCollisions(
  channels: NormalizedChannel[],
  n: NamingSettings,
  maxLength: number,
): { channels: NormalizedChannel[]; unresolved: number } {
  const max = maxLength > 0 ? maxLength : Infinity;
  let unresolved = 0;

  // Pass 1: tally initial names so we know which ones collide. When a name
  // appears more than once we want EVERY occurrence to get a suffix
  // (LUND1, LUND2, …) rather than the first staying bare (LUND, LUND1, …).
  const counts = new Map<string, number>();
  for (const ch of channels) {
    const name = ch.generated_name_final || "NONAME";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  // `taken` tracks every final name we've assigned so we don't accidentally
  // collide a suffixed name with an existing unique name.
  const taken = new Set<string>();
  for (const ch of channels) {
    const name = ch.generated_name_final || "NONAME";
    if ((counts.get(name) ?? 0) <= 1) {
      taken.add(name);
    }
  }

  // Övre gräns för antal försök: sekvensen kan bara producera ändligt många
  // distinkta namn inom `max` tecken, så vi behöver aldrig fler försök än
  // antalet redan tagna namn plus marginal för suffixlängdsbyten.
  const attemptLimit = channels.length + 64;

  // Per-base counter — assigns 1, 2, 3… in document order to each occurrence
  // of a colliding base name.
  const perBase = new Map<string, number>();
  const out = channels.map((ch) => {
    const name = ch.generated_name_final || "NONAME";
    if ((counts.get(name) ?? 0) <= 1) {
      return ch.generated_name_final === name ? ch : { ...ch, generated_name_final: name };
    }
    let attempt = (perBase.get(name) ?? 0) + 1;
    let candidate = candidateName(name, suffixFor(n.collisionPolicy, attempt), max);
    let tries = 0;
    while (taken.has(candidate) && tries < attemptLimit) {
      attempt++;
      tries++;
      candidate = candidateName(name, suffixFor(n.collisionPolicy, attempt), max);
    }
    perBase.set(name, attempt);
    const exhausted = taken.has(candidate);
    taken.add(candidate);
    if (exhausted) {
      unresolved++;
      return {
        ...ch,
        collided: true,
        generated_name_final: candidate,
        warnings: ch.warnings.some((w) => w.code === "unresolved_name_collision")
          ? ch.warnings
          : [
              ...ch.warnings,
              {
                code: "unresolved_name_collision" as const,
                message: "Namnrymden är uttömd – kanalnamnet är inte unikt",
              },
            ],
      };
    }
    return { ...ch, collided: true, generated_name_final: candidate };
  });
  return { channels: out, unresolved };
}
