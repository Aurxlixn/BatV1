// ---------- Pilotage du bateau : V8.5 (liaison + états + barre) ----------
const VERSION_SCRIPT = '8.5';

// ---------- Réglages ----------
const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const ANGLE_BARRE_MAX = 40;    // degrés affichés à fond : doit égaler 100 x FACTEUR (0.4) du programme micro:bit
const ZONE_MORTE = 6;          // en %, petite zone neutre au centre du joystick de barre
const DUREE_ARMEMENT = 1000;   // ms de maintien pour réarmer
const FENETRE_DOUBLE = 700;    // ms entre les deux appuis d'un double appui

const $ = id => document.getElementById(id);

// ---------- États ----------
const ETATS = {
  deconnecte: { nom: 'Non connecté', bouton: 'Se connecter', aide: 'Un appui' },
  verrouille: { nom: 'Verrouillé',   bouton: 'Réarmer',      aide: 'Maintenir 1 s' },
  pret:       { nom: 'Prêt',         bouton: 'Démarrer',     aide: 'Double clic' },
  marche:     { nom: 'En marche',    bouton: 'Arrêt',        aide: 'Double clic' }
};

// ---------- Variables ----------
let etat = 'deconnecte';
let appareil = null;
let caracEcriture = null;
let enConnexion = false;
let deconnexionVoulue = false;
let liaisonPerdue = false;

let fileEvenements = [];       // ordres importants : jamais écrasés, envoyés dans l'ordre
let positionEnAttente = null;  // seule la dernière position de barre compte
let enEcriture = false;
let generationLiaison = 0;

let pointeurAct = null, minuteurArmement = null, armementFait = false;
let armeJusqua = 0, minuteurDouble = null;

let pointeurBarre = null, derniereCommandeBarre = null, pctBarre = 0;

// ---------- Journal ----------
function journal(texte) {
  const heure = new Date().toLocaleTimeString('fr-FR');
  const zone = $('journal');
  zone.textContent = (heure + '  ' + texte + '\n' + zone.textContent).slice(0, 6000);
}

// ---------- Affichage ----------
function formatAngle(pct) {
  const angle = Math.round(pct * ANGLE_BARRE_MAX / 100);
  return (angle > 0 ? '+' : '') + angle + '°';
}

function majValeurs() {
  $('vBar').textContent = etat === 'deconnecte' ? '—' : formatAngle(pctBarre);
}

function afficherEcran() {
  const e = ETATS[etat];
  const connecte = caracEcriture !== null;
  const perdue = liaisonPerdue && etat === 'deconnecte';
  const arme = Date.now() < armeJusqua;
  const pilotable = (etat === 'pret' || etat === 'marche');

  document.body.dataset.etat = etat;
  document.body.dataset.perdue = perdue ? '1' : '0';
  $('pastille').textContent = enConnexion ? 'Connexion…' : perdue ? 'Liaison perdue' : e.nom;
  $('lienTxt').textContent = connecte ? 'Bluetooth : connecté' : 'Bluetooth : non connecté';
  $('actTxt').textContent = enConnexion ? 'Connexion…' : arme ? 'Touche encore' : e.bouton;
  $('aide').textContent = e.aide;
  $('act').classList.toggle('arme', arme);
  $('act').disabled = enConnexion;
  $('testEnvoi').disabled = !connecte;
  $('urgence').disabled = !pilotable;
  $('barre').classList.toggle('off', !pilotable);
  majValeurs();
}

function changerEtat(nouveau) {
  if (etat === nouveau) return;
  etat = nouveau;
  annulerDoubleAppui();
  if (nouveau !== 'pret' && nouveau !== 'marche') relacherBarre(true);
  journal('État : ' + ETATS[nouveau].nom);
  afficherEcran();
}

// ---------- Envoi Bluetooth ----------
// Les ordres (ARMER, MARCHE, ARRET, URGENCE...) passent toujours, dans l'ordre.
// Pour la barre, seule la dernière position compte : les anciennes sont abandonnées.
function viderEnvois() {
  generationLiaison++;
  fileEvenements = [];
  positionEnAttente = null;
}

function envoyerEvenement(texte) {
  if (!caracEcriture) return;
  fileEvenements.push(texte);
  pomper();
}

function envoyerPosition(texte) {
  if (!caracEcriture) return;
  positionEnAttente = texte;
  pomper();
}

async function pomper() {
  if (enEcriture) return;
  enEcriture = true;
  const generation = generationLiaison;
  const canal = caracEcriture;
  try {
    while (canal && generation === generationLiaison && caracEcriture === canal) {
      let message, estPosition = false;
      if (fileEvenements.length > 0) {
        message = fileEvenements.shift();
      } else if (positionEnAttente !== null) {
        message = positionEnAttente;
        positionEnAttente = null;
        estPosition = true;
      } else {
        break;
      }
      try {
        const octets = new TextEncoder().encode(message + '\n');
        if (canal.properties.writeWithoutResponse) await canal.writeValueWithoutResponse(octets);
        else await canal.writeValue(octets);
        if (!estPosition && generation === generationLiaison) journal('Envoyé : ' + message);
      } catch (e) {
        journal("Erreur d'envoi (" + message + ') : ' + e.message);
      }
    }
  } finally {
    enEcriture = false;
    // Des messages ont pu arriver pendant la fin de l'écriture, ou avec une nouvelle connexion.
    if (caracEcriture && (fileEvenements.length > 0 || positionEnAttente !== null)) pomper();
  }
}

// ---------- Connexion ----------
function surDeconnexion(e) {
  if (e && e.target !== appareil) return;   // ignore un ancien appareil
  const etaitConnecte = caracEcriture !== null;
  caracEcriture = null;
  viderEnvois();
  liaisonPerdue = etaitConnecte && !deconnexionVoulue;
  journal(liaisonPerdue ? 'Liaison perdue' : 'Déconnecté');
  deconnexionVoulue = false;
  relacherBarre(false);
  reinitialiserBouton();
  changerEtat('deconnecte');
  afficherEcran();
}

async function connecter() {
  if (enConnexion || caracEcriture) return;
  if (!navigator.bluetooth) {
    journal('Web Bluetooth indisponible : utilise Bluefy (iPhone) ou Chrome (Mac)');
    return;
  }
  enConnexion = true;
  afficherEcran();
  let candidat = null;
  try {
    journal('Recherche de la micro:bit...');
    candidat = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [UART_SERVICE]
    });
    const serveur = await candidat.gatt.connect();
    const service = await serveur.getPrimaryService(UART_SERVICE);

    // On prend le canal qui accepte l'écriture (son code varie selon les cartes)
    const canaux = await service.getCharacteristics();
    const canal = canaux.find(c => c.properties.write || c.properties.writeWithoutResponse);
    if (!canal) throw new Error("Aucun canal d'écriture trouvé");

    // On ne publie la connexion qu'une fois toute l'initialisation réussie
    if (appareil && appareil !== candidat) {
      appareil.removeEventListener('gattserverdisconnected', surDeconnexion);
    }
    appareil = candidat;
    appareil.addEventListener('gattserverdisconnected', surDeconnexion);
    caracEcriture = canal;
    deconnexionVoulue = false;
    liaisonPerdue = false;
    viderEnvois();
    pctBarre = 0;
    derniereCommandeBarre = null;
    journal("Canal d'écriture : " + canal.uuid.slice(0, 8));
    journal('Connecté à ' + (appareil.name || 'micro:bit'));
    changerEtat('verrouille');              // toute connexion démarre verrouillée
  } catch (e) {
    journal(e.name === 'NotFoundError' ? 'Aucun appareil choisi' : 'Échec : ' + e.message);
    caracEcriture = null;
    viderEnvois();
    if (candidat && candidat.gatt.connected) candidat.gatt.disconnect();
    if (candidat && candidat === appareil) {
      candidat.removeEventListener('gattserverdisconnected', surDeconnexion);
      appareil = null;
    }
    changerEtat('deconnecte');
  } finally {
    enConnexion = false;
    afficherEcran();
  }
}

function deconnecter() {
  if (!appareil || !appareil.gatt.connected) return;
  deconnexionVoulue = true;
  caracEcriture = null;
  viderEnvois();
  relacherBarre(false);
  afficherEcran();
  appareil.gatt.disconnect();
}

// ---------- Bouton principal : se connecter / réarmer (maintien) / démarrer, arrêter (double appui) ----------
const act = $('act');
const jauge = act.querySelector('.fill');

function annulerDoubleAppui() {
  clearTimeout(minuteurDouble);
  minuteurDouble = null;
  armeJusqua = 0;
}

function reinitialiserBouton() {
  clearTimeout(minuteurArmement);
  minuteurArmement = null;
  jauge.classList.remove('go');
  pointeurAct = null;
  armementFait = false;
  annulerDoubleAppui();
}

act.addEventListener('pointerdown', e => {
  if (enConnexion || pointeurAct !== null) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  pointeurAct = e.pointerId;
  armementFait = false;
  try { act.setPointerCapture(e.pointerId); } catch (_) {}

  if (etat === 'verrouille' && caracEcriture) {
    jauge.classList.add('go');                     // jauge qui se remplit pendant 1 s
    minuteurArmement = setTimeout(() => {
      if (pointeurAct === e.pointerId && caracEcriture && etat === 'verrouille') {
        armementFait = true;
        jauge.classList.remove('go');
        envoyerEvenement('ARMER');
        changerEtat('pret');
      }
    }, DUREE_ARMEMENT);
  }
});

act.addEventListener('pointerup', e => {
  if (e.pointerId !== pointeurAct) return;
  clearTimeout(minuteurArmement);
  minuteurArmement = null;
  jauge.classList.remove('go');
  pointeurAct = null;

  if (armementFait) { armementFait = false; return; }
  if (enConnexion) return;
  if (etat === 'deconnecte') { connecter(); return; }
  if (etat === 'verrouille') return;               // relâché trop tôt : rien

  if (Date.now() < armeJusqua) {                   // second appui dans la fenêtre : on valide
    annulerDoubleAppui();
    if (etat === 'pret') { envoyerEvenement('MARCHE'); changerEtat('marche'); }
    else if (etat === 'marche') { envoyerEvenement('ARRET'); changerEtat('pret'); }
    afficherEcran();
  } else {                                         // premier appui : on arme et on le montre
    armeJusqua = Date.now() + FENETRE_DOUBLE;
    minuteurDouble = setTimeout(() => { annulerDoubleAppui(); afficherEcran(); }, FENETRE_DOUBLE);
    afficherEcran();
  }
});

act.addEventListener('pointercancel', e => {
  if (e.pointerId === pointeurAct) { reinitialiserBouton(); afficherEcran(); }
});
act.addEventListener('lostpointercapture', e => {
  if (e.pointerId === pointeurAct) { reinitialiserBouton(); afficherEcran(); }
});
act.addEventListener('contextmenu', e => e.preventDefault());

// ---------- Urgence : un seul appui, réagit dès le contact ----------
$('urgence').addEventListener('pointerdown', e => {
  if (etat !== 'pret' && etat !== 'marche') return;
  e.preventDefault();
  envoyerEvenement('URGENCE');
  changerEtat('verrouille');
});

// ---------- Bouton de test ----------
$('testEnvoi').addEventListener('click', () => envoyerEvenement('bonjour'));

// ---------- Joystick de barre (proportionnel, revient au centre quand on le lâche) ----------
const joystickBarre = $('barre');
const boutonBarre = joystickBarre.querySelector('.knob');

function deplacerBarre(positionX) {
  const rect = joystickBarre.getBoundingClientRect();
  const course = (rect.width - boutonBarre.offsetWidth) / 2;
  if (course <= 0) return;
  let deplacement = positionX - (rect.left + rect.width / 2);
  deplacement = Math.max(-course, Math.min(course, deplacement));
  boutonBarre.style.transform = `translateX(${deplacement}px)`;
  let pct = Math.round(deplacement / course * 100);
  if (Math.abs(pct) < ZONE_MORTE) pct = 0;
  pctBarre = pct;
  majValeurs();
  if (pct !== derniereCommandeBarre) {
    derniereCommandeBarre = pct;
    envoyerPosition('BARRE:' + pct);
  }
}

function relacherBarre(transmettre = true) {
  if (pointeurBarre === null) return;
  const id = pointeurBarre;
  pointeurBarre = null;
  pctBarre = 0;
  boutonBarre.style.transform = 'translateX(0px)';
  joystickBarre.classList.remove('actif');
  if (joystickBarre.hasPointerCapture(id)) joystickBarre.releasePointerCapture(id);
  majValeurs();
  if (transmettre && caracEcriture) {
    derniereCommandeBarre = 0;
    envoyerPosition('BARRE:0');
  } else {
    derniereCommandeBarre = null;
  }
}

joystickBarre.addEventListener('pointerdown', e => {
  if (pointeurBarre !== null) return;
  if (!caracEcriture || (etat !== 'pret' && etat !== 'marche')) return;   // barre active en Prêt et En marche
  pointeurBarre = e.pointerId;
  joystickBarre.classList.add('actif');
  joystickBarre.setPointerCapture(e.pointerId);
  deplacerBarre(e.clientX);
});
joystickBarre.addEventListener('pointermove', e => {
  if (e.pointerId === pointeurBarre) deplacerBarre(e.clientX);
});
joystickBarre.addEventListener('pointerup', e => {
  if (e.pointerId === pointeurBarre) relacherBarre();
});
joystickBarre.addEventListener('pointercancel', e => {
  if (e.pointerId === pointeurBarre) relacherBarre();
});
joystickBarre.addEventListener('lostpointercapture', e => {
  if (e.pointerId === pointeurBarre) relacherBarre();
});

// ---------- Démarrage ----------
afficherEcran();
journal('Script version ' + VERSION_SCRIPT + ' chargé');
