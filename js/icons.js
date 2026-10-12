// Inline SVG icons (24x24 stroke icons use currentColor; building icons are small colourful roofs).

const s = (inner, extra = '') => `<svg viewBox="0 0 24 24" ${extra} aria-hidden="true">${inner}</svg>`;

export const ICONS = {
  hand: s('<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>'),
  road: s('<path d="M5 21C5 13 14 11 14 3"/><path d="M11 21c0-6 9-8 9-18"/><path d="M8 21c0-7 8.5-9 8.5-18" stroke-dasharray="2 3" stroke-width="1.5"/>'),
  roundabout: s('<circle cx="12" cy="12" r="4.8"/><path d="M12 3v4.2M12 16.8V21M3 12h4.2M16.8 12H21"/>'),
  lane: s('<path d="M6.5 3v18M17.5 3v18"/><path d="M12 8v8M8.4 12h7.2"/>'),
  signal: s('<rect x="7.5" y="2.5" width="9" height="19" rx="3.2"/><circle cx="12" cy="7.6" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="16.4" r="1.5"/>'),
  bin: s('<path d="M4 7h16M9.5 7V4h5v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>'),
  undo: s('<path d="M9 6L4 11l5 5"/><path d="M4 11h9a6.5 6.5 0 0 1 0 13" transform="translate(0 -3)"/>'),
  menu: s('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  flow: s('<path d="M4.5 17a8 8 0 1 1 15 0"/><path d="M12 17l4-5.5"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/>'),
  pause: s('<path d="M8.5 5.5v13M15.5 5.5v13" stroke-width="3"/>'),
  play: s('<path d="M7 5l12 7-12 7z" fill="currentColor"/>'),
  check: s('<path d="M5 12.5l4.5 4.5L19.5 7"/>'),
  close: s('<path d="M6 6l12 12M18 6L6 18"/>'),
  back: s('<path d="M15 5l-7 7 7 7"/>'),
  dice: s('<rect x="4" y="4" width="16" height="16" rx="4.5"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>'),
  download: s('<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>'),
  settings: s('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  help: s('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.9"/><circle cx="12" cy="17" r=".7" fill="currentColor"/>'),
  bridge: s('<path d="M3 18h18"/><path d="M5 18c1.5-9 12.5-9 14 0"/>'),
  oneway: s('<path d="M4 12h14M13 7l5 5-5 5"/>'),
  straight: s('<path d="M4 19L20 5"/><circle cx="4" cy="19" r="1.6"/><circle cx="20" cy="5" r="1.6"/>'),
  plus: s('<path d="M12 5v14M5 12h14"/>'),
  minus: s('<path d="M5 12h14"/>'),
  play2: s('<path d="M5 6l7 6-7 6zM12 6l7 6-7 6z" fill="currentColor"/>'),
};

const b = (inner) => `<svg viewBox="0 0 40 40" aria-hidden="true">${inner}</svg>`;
export const BUILDING_ICONS = {
  house: b('<rect x="7" y="9" width="26" height="22" rx="3" fill="rgba(0,0,0,.14)" transform="translate(2 2)"/><path d="M5 17L20 7l15 10v14H5z" fill="#79b04a"/><path d="M20 7l15 10v14H20z" fill="#5d9a37"/><rect x="28" y="22" width="8" height="9" rx="1.5" fill="#97c862"/>'),
  shop: b('<rect x="6" y="9" width="28" height="22" rx="3" fill="rgba(0,0,0,.14)" transform="translate(2 2)"/><rect x="5" y="8" width="30" height="24" rx="3" fill="#3f72de"/><g stroke="#2d57b8" stroke-width="1.6"><path d="M10 11v18M15 11v18M20 11v18M25 11v18M30 11v18"/></g>'),
  office: b('<rect x="7" y="7" width="26" height="26" rx="3" fill="rgba(0,0,0,.14)" transform="translate(2 2)"/><rect x="6" y="6" width="28" height="28" rx="3" fill="#7048c8"/><rect x="11" y="11" width="16" height="16" rx="2" fill="#5a38ab"/><rect x="16" y="16" width="6" height="6" rx="1" fill="#8d68de"/>'),
  factory: b('<rect x="6" y="8" width="30" height="24" rx="3" fill="rgba(0,0,0,.14)" transform="translate(2 2)"/><rect x="4" y="7" width="32" height="26" rx="3" fill="#74777d"/><g fill="#e8873b"><rect x="8" y="11" width="6" height="18" rx="1"/><rect x="17" y="11" width="6" height="18" rx="1"/><rect x="26" y="11" width="6" height="18" rx="1"/></g>'),
};
