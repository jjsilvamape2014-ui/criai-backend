// Ícones vetoriais simples (traço), desenhados numa caixa 100×100.
// O roteiro do LLM escolhe pelo NOME — só nomes desta lista são aceitos.

const P = {
  // clima / casa
  snowflake: '<path d="M50 10v80M15 30l70 40M15 70l70-40"/><path d="M40 16l10 9 10-9M40 84l10-9 10 9M16 42l13-3-4-13M84 58l-13 3 4 13M16 58l13 3-4 13M84 42l-13-3 4-13"/>',
  drop: '<path d="M50 10C50 10 22 44 22 62a28 28 0 0 0 56 0C78 44 50 10 50 10z"/><path d="M38 64a12 12 0 0 0 12 12"/>',
  thermometer: '<path d="M42 58V20a8 8 0 0 1 16 0v38a18 18 0 1 1-16 0z"/><path d="M50 36v34"/>',
  sun: '<circle cx="50" cy="50" r="17"/><path d="M50 10v10M50 80v10M10 50h10M80 50h10M22 22l7 7M71 71l7 7M22 78l7-7M71 29l7-7"/>',
  fire: '<path d="M50 90c-17 0-28-11-28-27 0-18 18-26 18-46 11 7 22 20 22 34 4-3 6-8 6-13 7 7 10 16 10 25 0 16-11 27-28 27z"/>',
  home: '<path d="M14 48L50 16l36 32"/><path d="M24 40v46h52V40"/><path d="M42 86V62h16v24"/>',
  bolt: '<path d="M56 8L22 56h26l-6 36 36-50H52z"/>',
  leaf: '<path d="M20 80C20 40 44 18 84 16c0 42-22 66-60 66z"/><path d="M20 80l40-40"/>',
  // serviço / ferramentas
  wrench: '<path d="M62 14a22 22 0 0 0-20 30L14 72a9 9 0 0 0 13 13l28-28a22 22 0 0 0 30-20l-13 13-12-4-4-12z"/>',
  gear: '<circle cx="50" cy="50" r="14"/><path d="M50 12v12M50 76v12M12 50h12M76 50h12M23 23l9 9M68 68l9 9M23 77l9-9M68 32l9-9"/>',
  shield: '<path d="M50 10l34 12v26c0 22-15 36-34 42-19-6-34-20-34-42V22z"/><path d="M36 50l10 10 20-22"/>',
  check: '<circle cx="50" cy="50" r="38"/><path d="M32 52l12 12 24-28"/>',
  clock: '<circle cx="50" cy="50" r="38"/><path d="M50 26v26l16 10"/>',
  calendar: '<rect x="16" y="22" width="68" height="62" rx="8"/><path d="M16 40h68M34 12v18M66 12v18"/>',
  truck: '<path d="M8 28h50v40H8zM58 42h18l14 14v12H58z"/><circle cx="26" cy="72" r="8"/><circle cx="72" cy="72" r="8"/>',
  box: '<path d="M50 10l36 18v44L50 90 14 72V28z"/><path d="M14 28l36 18 36-18M50 46v44"/>',
  // comércio
  tag: '<path d="M14 14h34l40 40-34 34-40-40z"/><circle cx="32" cy="32" r="6"/>',
  money: '<rect x="10" y="26" width="80" height="48" rx="8"/><circle cx="50" cy="50" r="12"/><path d="M22 38v24M78 38v24"/>',
  cart: '<path d="M8 14h14l10 46h48l8-32H26"/><circle cx="38" cy="78" r="7"/><circle cx="72" cy="78" r="7"/>',
  star: '<path d="M50 10l12 26 28 3-21 19 6 28-25-15-25 15 6-28-21-19 28-3z"/>',
  heart: '<path d="M50 84S12 60 12 36a19 19 0 0 1 38-6 19 19 0 0 1 38 6c0 24-38 48-38 48z"/>',
  sparkles: '<path d="M40 14l6 20 20 6-20 6-6 20-6-20-20-6 20-6zM74 56l4 12 12 4-12 4-4 12-4-12-12-4 12-4z"/>',
  gift: '<rect x="14" y="36" width="72" height="18" rx="4"/><path d="M20 54v32h60V54M50 36v50M50 36c-8-18-26-18-26-6s26 6 26 6 26 6 26-6-18-12-26 6"/>',
  // atendimento
  phone: '<path d="M30 12l12 20-8 8a44 44 0 0 0 26 26l8-8 20 12-6 16c-38 2-70-30-68-68z"/>',
  chat: '<path d="M14 20h72v46H42L24 82V66H14z"/><path d="M30 38h40M30 50h26"/>',
  people: '<circle cx="36" cy="34" r="12"/><circle cx="68" cy="38" r="10"/><path d="M12 84c0-16 11-26 24-26s24 10 24 26M58 84c0-12 5-20 16-22 10 2 14 10 14 22"/>',
  location: '<path d="M50 90S20 58 20 38a30 30 0 0 1 60 0c0 20-30 52-30 52z"/><circle cx="50" cy="38" r="11"/>',
  // nichos comuns
  car: '<path d="M14 62l8-24h56l8 24v16H14z"/><path d="M14 62h72"/><circle cx="30" cy="78" r="7"/><circle cx="70" cy="78" r="7"/>',
  food: '<path d="M18 48h64a32 32 0 0 1-64 0z"/><path d="M12 48h76M36 30c0-8 8-8 8-16M56 30c0-8 8-8 8-16"/>',
  scissors: '<circle cx="26" cy="72" r="12"/><circle cx="26" cy="28" r="12"/><path d="M36 34l52 42M36 66l52-42"/>',
  tooth: '<path d="M30 14c-12 0-18 10-16 24 2 12 8 16 10 30 2 12 6 20 12 20s6-18 14-18 8 18 14 18 10-8 12-20c2-14 8-18 10-30 2-14-4-24-16-24-8 0-12 4-20 4s-12-4-20-4z"/>',
  paw: '<circle cx="28" cy="40" r="8"/><circle cx="44" cy="26" r="8"/><circle cx="60" cy="26" r="8"/><circle cx="76" cy="40" r="8"/><path d="M52 50c-14 0-26 16-26 28 0 10 12 10 26 6 14 4 26 4 26-6 0-12-12-28-26-28z"/>',
  building: '<path d="M18 88V14h40v74M58 36h24v52M10 88h80"/><path d="M30 28h16M30 44h16M30 60h16M68 52h4M68 68h4"/>',
  cake: '<rect x="16" y="46" width="68" height="40" rx="6"/><path d="M16 62c11 8 23 8 34 0s23-8 34 0M50 30v16M50 16c-4 6-4 10 0 14 4-4 4-8 0-14z"/>',
  bag: '<path d="M18 32h64l-6 56H24z"/><path d="M36 42V26a14 14 0 0 1 28 0v16"/>',
  // produto / tecnologia / resultado
  qrcode: '<rect x="14" y="14" width="28" height="28" rx="3"/><rect x="58" y="14" width="28" height="28" rx="3"/><rect x="14" y="58" width="28" height="28" rx="3"/><path d="M24 24h8v8h-8zM68 24h8v8h-8zM24 68h8v8h-8z"/><path d="M58 58h10v10M78 58h8M58 78h8v8M76 70v16h10"/>',
  nfc: '<rect x="30" y="12" width="40" height="76" rx="8"/><path d="M44 78h12"/><path d="M80 34a24 24 0 0 1 0 32M88 26a36 36 0 0 1 0 48M20 34a24 24 0 0 0 0 32M12 26a36 36 0 0 0 0 48"/>',
  wifi: '<path d="M10 40a56 56 0 0 1 80 0M22 54a38 38 0 0 1 56 0M34 68a20 20 0 0 1 32 0"/><circle cx="50" cy="80" r="4"/>',
  chart: '<path d="M14 86h72M22 86V60M42 86V44M62 86V52M82 86V26"/><path d="M18 50l22-18 20 10 26-24M72 18h14v14"/>',
  rocket: '<path d="M50 10c16 10 22 28 20 48H30c-2-20 4-38 20-48z"/><circle cx="50" cy="38" r="7"/><path d="M30 58l-12 14 16-2M70 58l12 14-16-2M42 70l8 20 8-20"/>',
  thumbsup: '<path d="M30 46h-14v40h14zM30 48l14-30c8 0 10 6 9 12l-3 14h26c6 0 10 6 8 12l-7 24c-1 4-5 6-9 6H30"/>',
  target: '<circle cx="50" cy="50" r="36"/><circle cx="50" cy="50" r="22"/><circle cx="50" cy="50" r="8"/><path d="M50 50l32-32M72 14l10 4 4 10"/>',
  hand: '<path d="M40 50V20a7 7 0 0 1 14 0v26M54 40a7 7 0 0 1 14 0v14M68 50a7 7 0 0 1 14 0v14c0 16-12 26-28 26-12 0-20-6-26-16L18 56a7 7 0 0 1 12-7l10 11"/>',
  eye: '<path d="M8 50s16-28 42-28 42 28 42 28-16 28-42 28S8 50 8 50z"/><circle cx="50" cy="50" r="12"/>',
  whatsapp: '<path d="M50 12a38 38 0 0 0-33 57l-5 19 20-5a38 38 0 1 0 18-71z"/><path d="M36 34c-2 10 10 28 26 30l6-6-8-6-5 4c-5-2-10-7-12-12l4-5-6-8z"/>'
};

const ICON_NAMES = Object.keys(P).filter((n) => n !== 'whatsapp');

function safeIcon(name, fallback = 'star') {
  return P[name] ? name : fallback;
}

// Desenha o ícone centrado em (cx, cy) com `size` px de lado
function icon(name, cx, cy, size, color = '#FFFFFF', { strokeWidth = 7, opacity = 1, fill = 'none', rotate = 0 } = {}) {
  const n = safeIcon(name);
  const s = size / 100;
  return `<g transform="translate(${(cx - size / 2).toFixed(1)} ${(cy - size / 2).toFixed(1)}) scale(${s.toFixed(4)}) rotate(${rotate} 50 50)" fill="${fill}" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}">${P[n]}</g>`;
}

module.exports = { icon, ICON_NAMES, safeIcon };
