// ---------- Pilotage du bateau : V9 (liaison + états + barre + vitesse + retour + signe de vie) ----------
const VERSION_SCRIPT = '9';

// ---------- Réglages ----------
const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const ANGLE_BARRE_MAX = 40;              // degrés affichés à fond : doit égaler 100 x FACTEUR (0.4) du programme micro:bit
const ZONE_MORTE = 6;                    // en %, petite zone neutre au centre des joysticks
const DUREE_ARMEMENT = 1000;             // ms de maintien pour réarmer
const FENETRE_DOUBLE = 700;              // ms entre les deux appuis d'un double appui
const PERIODE_BATTEMENT = 200;           // ms : la page renvoie barre et vitesse (signe de vie)
const DELAI_SANS_RETOUR = 3000;          // ms : la micro:bit ne répond plus -> liaison perdue
const DUREE_REPETITION_URGENCE = 1000;   // ms : l'ordre URGENCE est répété jusqu'à confirmation

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

let fileEvenements = [];                    // ordres importants : jamais écrasés, envoyés dans l'ordre
let positions = { BARRE: null, VIT: null }; // seule la dernière position de chaque type compte
let enEcriture = false;
let generationLiaison = 0;
let derniereErreurEnvoi = 0;

let timerBattement = null;
let retourActif = false;       // vrai dès que la micro:bit a répondu une fois
let etatMicro = null;          // dernier état annoncé par la micro:bit (0, 1 ou 2)
let dernierRetour = 0;
let tamponRetour = '';
let urgenceJusqua = 0;

let pointeurAct = null, minuteurArmement = null, armementFait = false;
let armeJusqua = 0, minuteurDouble = null;

let pointeurBarre = null, derniereCommandeBarre = null, pctBarre = 0;
let pointeurGaz = null, derniereCommandeGaz = null, vitesse = 0;

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
  $('vVit').textContent = etat === 'deconnecte' ? '—' : (vitesse > 0 ? '+' : '') + vitesse + ' %';
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
  $('gaz').classList.toggle('off', etat !== 'marche');     // vitesse : seulement en marche
  majValeurs();
}

function changerEtat(nouveau) {
  if (etat === nouveau) return;
  etat = nouveau;
  annulerDoubleAppui();
  if (nouveau !== 'pret' && nouveau !== 'marche') relacherBarre(true);
  if (nouveau !== 'marche') relacherGaz(true);
  journal('État : ' + ETATS[nouveau].nom);
  afficherEcran();
}

// ---------- Envoi Bluetooth ----------
// Les ordres (ARMER, MARCHE, ARRET, URGENCE...) passent toujours, dans l'ordre.
// Pour la barre et la vitesse, seule la dernière position compte : les anciennes sont abandonnées.
function viderEnvois() {
  generationLiaison++;
  fileEvenements = [];
  positions = { BARRE: null, VIT: null };
}

function envoyerEvenement(texte, muet = false) {
  if (!caracEcriture) return;
  fileEvenements.push({ texte, muet });
  pomper();
}

function envoyerPosition(texte) {
  if (!caracEcriture) return;
  positions[texte.split(':')[0]] = texte;
  pomper();
}

function resteAEnvoyer() {
  return fileEvenements.length > 0 || positions.BARRE !== null || positions.VIT !== null;
}

async function pomper() {
  if (enEcriture) return;
  enEcriture = true;
  const generation = generationLiaison;
  const canal = caracEcriture;
  try {
    while (canal && generation === generationLiaison && caracEcriture === canal) {
      let message, muet = true;
      if (fileEvenements.length > 0) {
        const ev = fileEvenements.shift();
        message = ev.texte;
        muet = ev.muet;
      } else if (positions.BARRE !== null) {
        message = positions.BARRE;
        positions.BARRE = null;
      } else if (positions.VIT !== null) {
        message = positions.VIT;
        positions.VIT = null;
      } else {
        break;
      }
      try {
        const octets = new TextEncoder().encode(message + '\n');
        if (canal.properties.writeWithoutResponse) await canal.writeValueWithoutResponse(octets);
        else await canal.writeValue(octets);
        if (!muet && generation === generationLiaison) journal('Envoyé : ' + message);
      } catch (e) {
        if (Date.now() - derniereErreurEnvoi > 1000) {   // évite d'inonder le journal
          derniereErreurEnvoi = Date.now();
          journal("Erreur d'envoi (" + message + ') : ' + e.message);
        }
      }
    }
  } finally {
    enEcriture = false;
    // Des messages ont pu arriver pendant la fin de l'écriture, ou avec une nouvelle connexion.
    if (caracEcriture && resteAEnvoyer()) pomper();
  }
}

// ---------- Retour de la micro:bit (elle annonce son état : "E:0", "E:1" ou "E:2") ----------
function surRetour(ev) {
  tamponRetour += new TextDecoder().decode(ev.target.value);
  let i;
  while ((i = tamponRetour.indexOf('\n')) >= 0) {
    const ligne = tamponRetour.slice(0, i).trim();
    tamponRetour = tamponRetour.slice(i + 1);
    traiterRetour(ligne);
  }
  if (tamponRetour.length > 200) tamponRetour = '';
}

function traiterRetour(ligne) {
  dernierRetour = Date.now();
  if (!ligne.startsWith('E:')) return;
  const n = parseInt(ligne.slice(2), 10);
  if (n !== 0 && n !== 1 && n !== 2) return;
  if (!retourActif) { retourActif = true; journal('Retour de la micro:bit actif'); }
  etatMicro = n;
  if (n === 0) urgenceJusqua = 0;                   // verrouillage confirmé
  else if (Date.now() < urgenceJusqua) return;      // message ancien : la carte n'a pas encore reçu l'urgence
  const cle = ['verrouille', 'pret', 'marche'][n];
  if (!caracEcriture || cle === etat) return;
  if (n === 0 && (etat === 'pret' || etat === 'marche')) journal("La micro:bit s'est verrouillée");
  changerEtat(cle);
}

// Une demande d'état (ARMER, MARCHE, ARRET). Avec le retour de la micro:bit, c'est elle qui décide :
// la page attend sa confirmation. Sans retour, elle change d'état tout de suite, comme avant.
function demander(ordre, etatVise) {
  envoyerEvenement(ordre);
  if (!retourActif) changerEtat(etatVise);
}

// ---------- Signe de vie ----------
function battement() {
  if (!caracEcriture) return;
  // L'ordre URGENCE est répété jusqu'à ce que la micro:bit confirme son verrouillage
  if (Date.now() < urgenceJusqua && etatMicro !== 0) envoyerEvenement('URGENCE', true);
  // La page renvoie la position courante : c'est le signe de vie attendu par la micro:bit
  envoyerPosition('BARRE:' + pctBarre);
  envoyerPosition('VIT:' + vitesse);
  // La micro:bit annonce son état toutes les 500 ms : si elle se tait, la liaison est perdue
  if (retourActif && Date.now() - dernierRetour > DELAI_SANS_RETOUR) {
    journal('Plus de réponse de la micro:bit');
    perteDeLiaison();
  }
}

function perteDeLiaison() {
  deconnexionVoulue = false;
  const a = appareil;
  surDeconnexion({ target: a });       // met l'écran à jour tout de suite
  try { if (a && a.gatt.connected) a.gatt.disconnect(); } catch (_) {}
}

// ---------- Connexion ----------
function surDeconnexion(e) {
  if (e && e.target !== appareil) return;                         // ignore un ancien appareil
  if (caracEcriture === null && etat === 'deconnecte') return;    // déjà traité
  const etaitConnecte = caracEcriture !== null;
  caracEcriture = null;
  clearInterval(timerBattement);
  timerBattement = null;
  viderEnvois();
  liaisonPerdue = etaitConnecte && !deconnexionVoulue;
  journal(liaisonPerdue ? 'Liaison perdue' : 'Déconnecté');
  deconnexionVoulue = false;
  retourActif = false;
  etatMicro = null;
  tamponRetour = '';
  urgenceJusqua = 0;
  relacherBarre(false);
  relacherGaz(false);
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

    // Canal de retour (notifications) : facultatif, la connexion marche aussi sans lui
    const canalRetour = canaux.find(c => c.properties.notify);
    let retourDemarre = false;
    if (canalRetour) {
      try {
        await canalRetour.startNotifications();
        canalRetour.addEventListener('characteristicvaluechanged', surRetour);
        retourDemarre = true;
      } catch (e) {
        journal('Pas de retour de la micro:bit : ' + e.message);
      }
    } else {
      journal('Pas de canal de retour sur la micro:bit');
    }

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
    vitesse = 0;
    derniereCommandeGaz = null;
    retourActif = false;
    etatMicro = null;
    tamponRetour = '';
    urgenceJusqua = 0;
    dernierRetour = Date.now();
    clearInterval(timerBattement);
    timerBattement = setInterval(battement, PERIODE_BATTEMENT);
    journal("Canal d'écriture : " + canal.uuid.slice(0, 8));
    journal('Connecté à ' + (appareil.name || 'micro:bit'));
    journal(retourDemarre ? 'Retour de la micro:bit : en attente' : 'Mode sans retour de la micro:bit');
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

// Déconnexion voulue (utilisable dès qu'un bouton d'id "deco" existe dans la page)
function deconnecter() {
  if (!appareil || !appareil.gatt.connected) return;
  deconnexionVoulue = true;
  caracEcriture = null;
  viderEnvois();
  relacherBarre(false);
  relacherGaz(false);
  afficherEcran();
  appareil.gatt.disconnect();   // la micro:bit se verrouille d'elle-même à la déconnexion
}
if ($('deco')) $('deco').addEventListener('click', deconnecter);

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
        demander('ARMER', 'pret');
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
    if (etat === 'pret') demander('MARCHE', 'marche');
    else if (etat === 'marche') demander('ARRET', 'pret');
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

// ---------- Urgence : un seul appui, réagit dès le contact, verrouille tout de suite ----------
$('urgence').addEventListener('pointerdown', e => {
  if (etat !== 'pret' && etat !== 'marche') return;
  e.preventDefault();
  urgenceJusqua = Date.now() + DUREE_REPETITION_URGENCE;
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

// ---------- Joystick de vitesse (vertical : haut = avant, bas = arrière, revient à 0 quand on le lâche) ----------
const joystickGaz = $('gaz');
const boutonGaz = joystickGaz.querySelector('.knob');

function deplacerGaz(positionY) {
  const rect = joystickGaz.getBoundingClientRect();
  const course = (rect.height - boutonGaz.offsetHeight) / 2;
  if (course <= 0) return;
  let deplacement = positionY - (rect.top + rect.height / 2);   // positif = vers le bas
  deplacement = Math.max(-course, Math.min(course, deplacement));
  boutonGaz.style.transform = `translateY(${deplacement}px)`;
  let pct = Math.round(-deplacement / course * 100);            // vers le haut = avant = positif
  if (Math.abs(pct) < ZONE_MORTE) pct = 0;
  vitesse = pct;
  majValeurs();
  if (pct !== derniereCommandeGaz) {
    derniereCommandeGaz = pct;
    envoyerPosition('VIT:' + pct);
  }
}

function relacherGaz(transmettre = true) {
  if (pointeurGaz === null) return;
  const id = pointeurGaz;
  pointeurGaz = null;
  vitesse = 0;
  boutonGaz.style.transform = 'translateY(0px)';
  joystickGaz.classList.remove('actif');
  if (joystickGaz.hasPointerCapture(id)) joystickGaz.releasePointerCapture(id);
  majValeurs();
  if (transmettre && caracEcriture) {
    derniereCommandeGaz = 0;
    envoyerPosition('VIT:0');
  } else {
    derniereCommandeGaz = null;
  }
}

joystickGaz.addEventListener('pointerdown', e => {
  if (pointeurGaz !== null) return;
  if (!caracEcriture || etat !== 'marche') return;               // vitesse active seulement En marche
  pointeurGaz = e.pointerId;
  joystickGaz.classList.add('actif');
  joystickGaz.setPointerCapture(e.pointerId);
  deplacerGaz(e.clientY);
});
joystickGaz.addEventListener('pointermove', e => {
  if (e.pointerId === pointeurGaz) deplacerGaz(e.clientY);
});
joystickGaz.addEventListener('pointerup', e => {
  if (e.pointerId === pointeurGaz) relacherGaz();
});
joystickGaz.addEventListener('pointercancel', e => {
  if (e.pointerId === pointeurGaz) relacherGaz();
});
joystickGaz.addEventListener('lostpointercapture', e => {
  if (e.pointerId === pointeurGaz) relacherGaz();
});

// ---------- Démarrage ----------
afficherEcran();
journal('Script version ' + VERSION_SCRIPT + ' chargé');
