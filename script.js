
// PETIT BATEAU - JAVASCRIPT R1 (Refonte 1)
'use strict';
const VERSION = 'R1';
const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const PERIODE = 100;
const DELAI_ECRITURE = 600;
const ZONE_MORTE = 6;
const $ = id => document.getElementById(id);
const encodeur = new TextEncoder();

let liaison = null;
let connexionEnCours = false;
let vitesse = 0;
let angle = 90;
let info = 'Non connecté';

const gaz = creerJoystick('gaz', true, valeur => { vitesse = valeur; });
const barre = creerJoystick('barre', false, valeur => { angle = 90 + Math.round(valeur * 40 / 100); });

function pilotable() {
  return !!liaison && !connexionEnCours && !liaison.arret;
}

function valeurs() {
  $('vVit').textContent = vitesse + ' %';
  $('vBar').textContent = (angle - 90) + '°';
}

function affichage() {
  const actif = pilotable();
  document.body.dataset.connecte = actif ? '1' : '0';
  $('pastille').textContent = info;
  $('urgence').disabled = !actif;
  $('act').disabled = connexionEnCours || !!liaison?.arret;
  $('act').textContent = liaison ? 'Déconnecter' : 'Se connecter';
  $('gaz').classList.toggle('off', !actif);
  $('barre').classList.toggle('off', !actif);
  valeurs();
}

// Les deux joysticks ne font que mémoriser la consigne actuelle.
function creerJoystick(id, vertical, changer) {
  const zone = $(id);
  const bouton = zone.querySelector('.knob');
  let pointeur = null;

  function deplacer(e) {
    const r = zone.getBoundingClientRect();
    const course = vertical
      ? (zone.clientHeight - bouton.offsetHeight) / 2
      : (zone.clientWidth - bouton.offsetWidth) / 2;
    if (course <= 0) return;
    const delta = vertical ? e.clientY - (r.top + r.height / 2)
                           : e.clientX - (r.left + r.width / 2);
    const d = Math.max(-course, Math.min(course, delta));
    bouton.style.transform = vertical ? `translateY(${d}px)` : `translateX(${d}px)`;
    let v = Math.round((vertical ? -d : d) * 100 / course);
    if (Math.abs(v) < ZONE_MORTE) v = 0;
    changer(v);
    valeurs();
  }

  function neutre() {
    const p = pointeur;
    pointeur = null;
    changer(0);
    bouton.style.transform = '';
    zone.classList.remove('actif');
    if (p !== null && zone.hasPointerCapture(p)) zone.releasePointerCapture(p);
    valeurs();
  }

  zone.addEventListener('pointerdown', e => {
    if (!pilotable() || pointeur !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    zone.setPointerCapture(e.pointerId);
    pointeur = e.pointerId;
    zone.classList.add('actif');
    deplacer(e);
  });
  zone.addEventListener('pointermove', e => {
    if (e.pointerId === pointeur) deplacer(e);
  });
  for (const evenement of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    zone.addEventListener(evenement, e => {
      if (e.pointerId === pointeur) neutre();
    });
  }
  return { neutre };
}

function remettreAuNeutre() {
  gaz.neutre();
  barre.neutre();
}

// Une seule écriture en cours par liaison. Aucun tampon de consignes.
// Si une écriture ne se termine pas, on coupe la connexion par sécurité.
function ecrire(l, message) {
  if (l.envoi || liaison !== l || !l.appareil.gatt.connected) {
    return Promise.reject(new Error('Écriture indisponible'));
  }
  let timer;
  const octets = encodeur.encode(message + '\n');
  const c = l.canal;
  const operation = Promise.resolve().then(() => {
    if (liaison !== l || !l.appareil.gatt.connected) throw new Error('Liaison coupée');
    // Préférer l'acquittement GATT quand disponible (pas un retour UART).
    if (c.properties.write && typeof c.writeValueWithResponse === 'function') {
      return c.writeValueWithResponse(octets);
    }
    if (c.properties.write && typeof c.writeValue === 'function') {
      return c.writeValue(octets);
    }
    if (c.properties.writeWithoutResponse && typeof c.writeValueWithoutResponse === 'function') {
      return c.writeValueWithoutResponse(octets);
    }
    // Compatibilité avec les navigateurs qui exposent seulement l'ancienne API.
    return c.writeValue(octets);
  });
  const limite = new Promise((_, rejet) => {
    timer = setTimeout(() => rejet(new Error('Écriture Bluetooth trop longue')), DELAI_ECRITURE);
  });
  l.envoi = Promise.race([operation, limite]).finally(() => {
    clearTimeout(timer);
    l.envoi = null;
  });
  return l.envoi;
}

function fermer(l, texte) {
  if (liaison !== l) return;
  clearInterval(l.timer);
  liaison = null;
  l.appareil.removeEventListener('gattserverdisconnected', l.deconnexion);
  try { if (l.appareil.gatt.connected) l.appareil.gatt.disconnect(); } catch (_) {}
  remettreAuNeutre();
  info = texte;
  affichage();
}

function battement(l) {
  if (liaison !== l || l.arret || l.envoi) return;
  // Les positions sont lues au dernier moment, jamais mises en attente.
  ecrire(l, `${vitesse},${angle}`).catch(() => fermer(l, 'Liaison perdue'));
}

async function connecter() {
  if (connexionEnCours || liaison) return;
  if (!navigator.bluetooth) {
    info = 'Bluetooth indisponible';
    affichage();
    return;
  }
  connexionEnCours = true;
  info = 'Connexion…';
  affichage();
  let appareil;
  let l;
  try {
    // Même procédure de découverte que la V9, sans canal de retour.
    appareil = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [UART_SERVICE]
    });
    const serveur = await appareil.gatt.connect();
    const service = await serveur.getPrimaryService(UART_SERVICE);
    const canaux = await service.getCharacteristics();
    const canal = canaux.find(c => c.properties.write || c.properties.writeWithoutResponse);
    if (!canal || !appareil.gatt.connected || document.hidden) throw new Error('Liaison indisponible');

    l = { appareil, canal, envoi: null, timer: null, arret: false, deconnexion: null };
    l.deconnexion = () => fermer(l, 'Liaison perdue');
    liaison = l;
    appareil.addEventListener('gattserverdisconnected', l.deconnexion);
    remettreAuNeutre();
    // Toujours transmettre le neutre avant d'autoriser les joysticks.
    await ecrire(l, '0,90');
    if (liaison !== l || l.arret || document.hidden) throw new Error('Connexion interrompue');
    l.timer = setInterval(() => battement(l), PERIODE);
    info = 'Bluetooth connecté';
  } catch (e) {
    const texte = e.name === 'NotFoundError' ? 'Non connecté' : 'Échec de connexion';
    if (l && liaison === l) fermer(l, texte);
    else if (!l && appareil) {
      try { if (appareil.gatt.connected) appareil.gatt.disconnect(); } catch (_) {}
    }
    if (!l) info = texte;
  } finally {
    connexionEnCours = false;
    affichage();
  }
}

async function arreterEtDeconnecter(texte = 'Arrêt d’urgence') {
  const l = liaison;
  if (!l || l.arret) return;
  l.arret = true;                         // Interdit immédiatement tout pilotage.
  clearInterval(l.timer);
  remettreAuNeutre();
  info = 'Arrêt en cours…';
  affichage();
  try {
    if (l.envoi) await l.envoi;             // Attendre uniquement l'écriture déjà lancée.
    if (liaison === l && l.appareil.gatt.connected) await ecrire(l, 'STOP');
  } catch (_) {
    // Même sans STOP reçu, déconnexion et watchdog assurent la coupure embarquée.
  } finally {
    fermer(l, texte);
  }
}

$('act').addEventListener('click', () => {
  if (liaison) arreterEtDeconnecter('Déconnecté');
  else connecter();
});
$('urgence').addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  arreterEtDeconnecter();
});
$('urgence').addEventListener('click', () => arreterEtDeconnecter()); // Clavier / accessibilité.

// Ne jamais conserver des gaz si la page est masquée ou quittée.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) arreterEtDeconnecter('Déconnecté');
});
window.addEventListener('pagehide', () => arreterEtDeconnecter('Déconnecté'));
window.addEventListener('resize', () => {
  if (window.matchMedia('(orientation: portrait)').matches) remettreAuNeutre();
});

$('version').textContent = 'JS ' + VERSION + ' · Micro:bit ' + VERSION + ' attendue';
affichage();
