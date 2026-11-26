
// ==================================================
// PILOTAGE DU BATEAU - V10.5
// Compatible micro:bit V4
// Connexion Bluetooth reprise de la V9
// ==================================================

const VERSION_SCRIPT = '10.5';

// ---------- Réglages ----------

const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const ANGLE_BARRE_MAX = 40;
const ZONE_MORTE = 6;
const DUREE_ARMEMENT = 1000;
const FENETRE_DOUBLE = 700;
const PERIODE_BATTEMENT = 100;
const DELAI_SANS_RETOUR = 3000;
const DUREE_REPETITION_URGENCE = 1000;

const $ = id => document.getElementById(id);

// ---------- États ----------

const ETATS = {
  deconnecte: {
    nom: 'Non connecté',
    bouton: 'Se connecter',
    aide: 'Un appui'
  },
  verrouille: {
    nom: 'Verrouillé',
    bouton: 'Réarmer',
    aide: 'Maintenir 1 s'
  },
  pret: {
    nom: 'Prêt',
    bouton: 'Démarrer',
    aide: 'Double clic'
  },
  marche: {
    nom: 'En marche',
    bouton: 'Arrêt',
    aide: 'Double clic'
  }
};

// ---------- Variables ----------

let etat = 'deconnecte';
let appareil = null;
let caracEcriture = null;
let enConnexion = false;
let deconnexionVoulue = false;
let liaisonPerdue = false;

let fileEvenements = [];
let prochainType = 'VIT';
let dernierDiagnostic = '';
let dernierEnvoiVitesse = '';
let attenteArret = false;
let enEcriture = false;
let generationLiaison = 0;
let derniereErreurEnvoi = 0;

let timerBattement = null;
let retourActif = false;
let etatMicro = null;
let dernierRetour = 0;
let tamponRetour = '';
let urgenceJusqua = 0;

let pointeurAct = null;
let minuteurArmement = null;
let armementFait = false;
let armeJusqua = 0;
let minuteurDouble = null;

let pointeurBarre = null;
let derniereCommandeBarre = null;
let pctBarre = 0;

let pointeurGaz = null;
let derniereCommandeGaz = null;
let vitesse = 0;

// ---------- Journal ----------

function journal(texte) {
  const heure = new Date().toLocaleTimeString('fr-FR');
  const zone = $('journal');

  zone.textContent = (
    heure + '  ' + texte + '\n' + zone.textContent
  ).slice(0, 6000);
}

// ---------- Affichage ----------

function formatAngle(pct) {
  const angle = Math.round(
    pct * ANGLE_BARRE_MAX / 100
  );

  return (angle > 0 ? '+' : '') + angle + '°';
}

function majValeurs() {
  $('vBar').textContent =
    etat === 'deconnecte'
      ? '—'
      : formatAngle(pctBarre);

  $('vVit').textContent =
    etat === 'deconnecte'
      ? '—'
      : (vitesse > 0 ? '+' : '') + vitesse + ' %';
}

function afficherEcran() {
  const e = ETATS[etat];
  const connecte = caracEcriture !== null;

  const perdue =
    liaisonPerdue && etat === 'deconnecte';

  const arme = Date.now() < armeJusqua;

  const pilotable =
    etat === 'pret' || etat === 'marche';

  document.body.dataset.etat = etat;
  document.body.dataset.perdue = perdue ? '1' : '0';

  $('pastille').textContent = enConnexion
    ? 'Connexion…'
    : perdue
      ? 'Liaison perdue'
      : e.nom;

  $('lienTxt').textContent = connecte
    ? 'Bluetooth : connecté'
    : 'Bluetooth : non connecté';

  $('actTxt').textContent = enConnexion
    ? 'Connexion…'
    : arme
      ? 'Touche encore'
      : e.bouton;

  $('aide').textContent = e.aide;

  $('act').classList.toggle('arme', arme);
  $('act').disabled = enConnexion;
  $('testEnvoi').disabled = !connecte;
  $('urgence').disabled = !pilotable;

  $('barre').classList.toggle('off', !pilotable);

  $('gaz').classList.toggle(
    'off',
    etat !== 'marche' || attenteArret
  );

  majValeurs();
}

function changerEtat(nouveau) {
  if (etat === nouveau) return;

  etat = nouveau;

  annulerDoubleAppui();

  if (nouveau !== 'pret' && nouveau !== 'marche') {
    relacherBarre(true);
  }

  if (nouveau !== 'marche') {
    relacherGaz(true);
  }

  journal('État : ' + ETATS[nouveau].nom);

  afficherEcran();
}

// ---------- Envoi Bluetooth V10.5 ----------

function viderEnvois() {
  generationLiaison++;

  fileEvenements = [];

  prochainType = 'VIT';
  dernierDiagnostic = '';
  dernierEnvoiVitesse = '';
  attenteArret = false;
}

function envoyerEvenement(texte, muet = false) {
  if (!caracEcriture) return;

  // L'urgence annule les ordres en attente.

  if (texte === 'URGENCE') {
    fileEvenements = [];

  } else if (texte === 'ARRET') {
    fileEvenements = fileEvenements.filter(
      ev => ev.texte !== 'MARCHE'
    );
  }

  fileEvenements.push({ texte, muet });

  pomper(false);
}

// Une seule écriture Bluetooth à la fois.
// Les positions des joysticks sont envoyées
// alternativement, sans rafales.

async function pomper(positionsAutorisees) {

  if (enEcriture || !caracEcriture) return;

  let message;
  let muet = true;

  // Priorité aux ordres importants.

  if (fileEvenements.length) {

    const ev = fileEvenements.shift();

    message = ev.texte;
    muet = ev.muet;

  } else if (!positionsAutorisees) {

    return;

  } else if (prochainType === 'VIT') {

    const v =
      etat === 'marche' && !attenteArret
        ? vitesse
        : 0;

    // Protocole de la micro:bit fonctionnelle.

    message = v === 0
      ? 'P0'
      : v > 0
        ? 'F' + v
        : 'R' + (-v);

    prochainType = 'BARRE';

  } else {

    message = String(
      Math.round(
        90 + pctBarre * ANGLE_BARRE_MAX / 100
      )
    );

    prochainType = 'VIT';
  }

  enEcriture = true;

  const generation = generationLiaison;
  const canal = caracEcriture;

  try {

    const octets = new TextEncoder().encode(
      message + '\n'
    );

    if (canal.properties.writeWithoutResponse) {

      await canal.writeValueWithoutResponse(octets);

    } else {

      await canal.writeValue(octets);
    }

    if (generation === generationLiaison) {

      if (!muet) {
        journal('Envoyé : ' + message);
      }

      // Journalisation des changements de vitesse.

      if (
        /^(P0|[FR]\d+)$/.test(message) &&
        message !== dernierEnvoiVitesse
      ) {
        dernierEnvoiVitesse = message;

        journal('Écriture Bluetooth : ' + message);
      }
    }

  } catch (e) {

    if (
      generation === generationLiaison &&
      Date.now() - derniereErreurEnvoi > 1000
    ) {
      derniereErreurEnvoi = Date.now();

      journal(
        "Erreur d'envoi (" +
        message +
        ') : ' +
        e.message
      );
    }

  } finally {

    enEcriture = false;
  }
}

// ---------- Retour de la micro:bit V4 ----------
// Exemple : E:2,V:50,P:128

function surRetour(ev) {

  tamponRetour += new TextDecoder().decode(
    ev.target.value
  );

  let i;

  while ((i = tamponRetour.indexOf('\n')) >= 0) {

    const ligne = tamponRetour.slice(0, i).trim();

    tamponRetour = tamponRetour.slice(i + 1);

    traiterRetour(ligne);
  }

  if (tamponRetour.length > 200) {
    tamponRetour = '';
  }
}

function traiterRetour(ligne) {

  const m = /^E:([012]),V:(-?\d+),P:(\d+)$/.exec(ligne);

  if (!m) return;

  dernierRetour = Date.now();

  const n = Number(m[1]);

  if (!retourActif) {
    retourActif = true;

    journal('Retour micro:bit V4 actif');
  }

  etatMicro = n;

  if (n === 0) {

    urgenceJusqua = 0;

  } else if (Date.now() < urgenceJusqua) {

    return;
  }

  if (ligne !== dernierDiagnostic) {

    dernierDiagnostic = ligne;

    journal(
      'Micro:bit : état ' + n +
      ' | vitesse ' + m[2] +
      '% | PWM ' + m[3]
    );
  }

  if (n !== 2) {
    attenteArret = false;
  }

  const cle = [
    'verrouille',
    'pret',
    'marche'
  ][n];

  if (!caracEcriture) return;

  changerEtat(cle);

  afficherEcran();
}

// ---------- Demande de changement d'état ----------

function demander(ordre, etatVise) {

  if (ordre === 'ARRET') {

    attenteArret = true;

    relacherGaz(false);

    prochainType = 'VIT';
  }

  envoyerEvenement(ordre);

  // Conserve le mode sans retour de la V9.

  if (!retourActif) {

    changerEtat(etatVise);

    if (ordre === 'ARRET') {
      attenteArret = false;
    }

    journal(
      'État local : pas de confirmation micro:bit'
    );
  }

  afficherEcran();
}

// ---------- Signe de vie ----------

function battement() {

  if (!caracEcriture) return;

  if (
    retourActif &&
    Date.now() - dernierRetour > DELAI_SANS_RETOUR
  ) {
    journal('Plus de réponse de la micro:bit');

    perteDeLiaison();

    return;
  }

  // Répétition de l'urgence.

  if (
    Date.now() < urgenceJusqua &&
    etatMicro !== 0 &&
    !fileEvenements.some(ev => ev.texte === 'URGENCE')
  ) {
    fileEvenements.unshift({
      texte: 'URGENCE',
      muet: true
    });
  }

  // Un message toutes les 100 ms.
  // Chaque joystick est transmis environ toutes les 200 ms.

  pomper(true);
}

function perteDeLiaison() {

  deconnexionVoulue = false;

  const a = appareil;

  surDeconnexion({ target: a });

  try {

    if (a && a.gatt.connected) {
      a.gatt.disconnect();
    }

  } catch (_) {}
}

// ---------- Déconnexion ----------

function surDeconnexion(e) {

  if (e && e.target !== appareil) return;

  if (
    caracEcriture === null &&
    etat === 'deconnecte'
  ) return;

  const etaitConnecte =
    caracEcriture !== null;

  caracEcriture = null;

  clearInterval(timerBattement);
  timerBattement = null;

  viderEnvois();

  liaisonPerdue =
    etaitConnecte && !deconnexionVoulue;

  journal(
    liaisonPerdue
      ? 'Liaison perdue'
      : 'Déconnecté'
  );

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

// ==================================================
// CONNEXION BLUETOOTH
// Procédure originale V9 conservée.
// ==================================================

async function connecter() {

  if (enConnexion || caracEcriture) return;

  if (!navigator.bluetooth) {

    journal(
      'Web Bluetooth indisponible : utilise Bluefy (iPhone) ou Chrome (Mac)'
    );

    return;
  }

  enConnexion = true;

  afficherEcran();

  let candidat = null;

  try {

    journal('Recherche de la micro:bit...');

    candidat = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'BBC micro:bit' }
      ],
      optionalServices: [UART_SERVICE]
    });

    const serveur = await candidat.gatt.connect();

    const service = await serveur.getPrimaryService(
      UART_SERVICE
    );

    const canaux = await service.getCharacteristics();

    const canal = canaux.find(
      c =>
        c.properties.write ||
        c.properties.writeWithoutResponse
    );

    if (!canal) {
      throw new Error(
        "Aucun canal d'écriture trouvé"
      );
    }

    const canalRetour = canaux.find(
      c => c.properties.notify
    );

    let retourDemarre = false;

    if (canalRetour) {

      try {

        await canalRetour.startNotifications();

        canalRetour.addEventListener(
          'characteristicvaluechanged',
          surRetour
        );

        retourDemarre = true;

      } catch (e) {

        journal(
          'Pas de retour de la micro:bit : ' +
          e.message
        );
      }

    } else {

      journal(
        'Pas de canal de retour sur la micro:bit'
      );
    }

    if (appareil && appareil !== candidat) {

      appareil.removeEventListener(
        'gattserverdisconnected',
        surDeconnexion
      );
    }

    appareil = candidat;

    appareil.addEventListener(
      'gattserverdisconnected',
      surDeconnexion
    );

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

    timerBattement = setInterval(
      battement,
      PERIODE_BATTEMENT
    );

    journal(
      "Canal d'écriture : " +
      canal.uuid.slice(0, 8)
    );

    journal(
      'Connecté à ' +
      (appareil.name || 'micro:bit')
    );

    journal(
      retourDemarre
        ? 'Retour de la micro:bit : en attente'
        : 'Mode sans retour de la micro:bit'
    );

    changerEtat('verrouille');

  } catch (e) {

    journal(
      e.name === 'NotFoundError'
        ? 'Aucun appareil choisi'
        : 'Échec : ' + e.message
    );

    caracEcriture = null;

    viderEnvois();

    if (candidat && candidat.gatt.connected) {
      candidat.gatt.disconnect();
    }

    if (candidat && candidat === appareil) {

      candidat.removeEventListener(
        'gattserverdisconnected',
        surDeconnexion
      );

      appareil = null;
    }

    changerEtat('deconnecte');

  } finally {

    enConnexion = false;

    afficherEcran();
  }
}

// ---------- Déconnexion volontaire ----------

function deconnecter() {

  if (!appareil || !appareil.gatt.connected) return;

  deconnexionVoulue = true;
  caracEcriture = null;

  viderEnvois();

  relacherBarre(false);
  relacherGaz(false);

  afficherEcran();

  appareil.gatt.disconnect();
}

if ($('deco')) {

  $('deco').addEventListener(
    'click',
    deconnecter
  );
}

// ---------- Bouton principal ----------

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

  if (
    e.pointerType === 'mouse' &&
    e.button !== 0
  ) return;

  pointeurAct = e.pointerId;
  armementFait = false;

  try {

    act.setPointerCapture(e.pointerId);

  } catch (_) {}

  // Réarmement : maintenir une seconde.

  if (etat === 'verrouille' && caracEcriture) {

    jauge.classList.add('go');

    minuteurArmement = setTimeout(() => {

      if (
        pointeurAct === e.pointerId &&
        caracEcriture &&
        etat === 'verrouille'
      ) {
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

  if (armementFait) {

    armementFait = false;

    return;
  }

  if (enConnexion) return;

  if (etat === 'deconnecte') {

    connecter();

    return;
  }

  if (etat === 'verrouille') return;

  // Deuxième appui.

  if (Date.now() < armeJusqua) {

    annulerDoubleAppui();

    if (etat === 'pret') {

      demander('MARCHE', 'marche');

    } else if (etat === 'marche') {

      demander('ARRET', 'pret');
    }

    afficherEcran();

  } else {

    // Premier appui.

    armeJusqua = Date.now() + FENETRE_DOUBLE;

    minuteurDouble = setTimeout(() => {

      annulerDoubleAppui();

      afficherEcran();

    }, FENETRE_DOUBLE);

    afficherEcran();
  }
});

act.addEventListener('pointercancel', e => {

  if (e.pointerId === pointeurAct) {

    reinitialiserBouton();

    afficherEcran();
  }
});

act.addEventListener('lostpointercapture', e => {

  if (e.pointerId === pointeurAct) {

    reinitialiserBouton();

    afficherEcran();
  }
});

act.addEventListener(
  'contextmenu',
  e => e.preventDefault()
);

// ---------- Arrêt d'urgence ----------

$('urgence').addEventListener('pointerdown', e => {

  if (etat !== 'pret' && etat !== 'marche') return;

  e.preventDefault();

  urgenceJusqua =
    Date.now() + DUREE_REPETITION_URGENCE;

  envoyerEvenement('URGENCE');

  changerEtat('verrouille');
});

// ---------- Bouton de test ----------

$('testEnvoi').addEventListener('click', () => {

  envoyerEvenement('bonjour');
});

// ---------- Joystick de barre ----------

const joystickBarre = $('barre');

const boutonBarre =
  joystickBarre.querySelector('.knob');

function deplacerBarre(positionX) {

  const rect =
    joystickBarre.getBoundingClientRect();

  const course =
    (rect.width - boutonBarre.offsetWidth) / 2;

  if (course <= 0) return;

  let deplacement =
    positionX - (rect.left + rect.width / 2);

  deplacement = Math.max(
    -course,
    Math.min(course, deplacement)
  );

  boutonBarre.style.transform =
    `translateX(${deplacement}px)`;

  let pct = Math.round(
    deplacement / course * 100
  );

  if (Math.abs(pct) < ZONE_MORTE) {
    pct = 0;
  }

  pctBarre = pct;

  majValeurs();

  derniereCommandeBarre = pct;
}

function relacherBarre(transmettre = true) {

  if (pointeurBarre === null) return;

  const id = pointeurBarre;

  pointeurBarre = null;
  pctBarre = 0;

  boutonBarre.style.transform =
    'translateX(0px)';

  joystickBarre.classList.remove('actif');

  if (joystickBarre.hasPointerCapture(id)) {

    joystickBarre.releasePointerCapture(id);
  }

  majValeurs();

  if (transmettre && caracEcriture) {

    derniereCommandeBarre = 0;

  } else {

    derniereCommandeBarre = null;
  }
}

joystickBarre.addEventListener('pointerdown', e => {

  if (pointeurBarre !== null) return;

  if (
    !caracEcriture ||
    (etat !== 'pret' && etat !== 'marche')
  ) return;

  pointeurBarre = e.pointerId;

  joystickBarre.classList.add('actif');

  joystickBarre.setPointerCapture(e.pointerId);

  deplacerBarre(e.clientX);
});

joystickBarre.addEventListener('pointermove', e => {

  if (e.pointerId === pointeurBarre) {

    deplacerBarre(e.clientX);
  }
});

joystickBarre.addEventListener('pointerup', e => {

  if (e.pointerId === pointeurBarre) {

    relacherBarre();
  }
});

joystickBarre.addEventListener('pointercancel', e => {

  if (e.pointerId === pointeurBarre) {

    relacherBarre();
  }
});

joystickBarre.addEventListener(
  'lostpointercapture',
  e => {

    if (e.pointerId === pointeurBarre) {

      relacherBarre();
    }
  }
);

// ---------- Joystick de vitesse ----------

const joystickGaz = $('gaz');

const boutonGaz =
  joystickGaz.querySelector('.knob');

function deplacerGaz(positionY) {

  const rect =
    joystickGaz.getBoundingClientRect();

  const course =
    (rect.height - boutonGaz.offsetHeight) / 2;

  if (course <= 0) return;

  let deplacement =
    positionY - (rect.top + rect.height / 2);

  deplacement = Math.max(
    -course,
    Math.min(course, deplacement)
  );

  boutonGaz.style.transform =
    `translateY(${deplacement}px)`;

  let pct = Math.round(
    -deplacement / course * 100
  );

  if (Math.abs(pct) < ZONE_MORTE) {

    pct = 0;
  }

  vitesse = pct;

  majValeurs();

  derniereCommandeGaz = pct;
}

function relacherGaz(transmettre = true) {

  if (pointeurGaz === null) return;

  const id = pointeurGaz;

  pointeurGaz = null;
  vitesse = 0;

  boutonGaz.style.transform =
    'translateY(0px)';

  joystickGaz.classList.remove('actif');

  if (joystickGaz.hasPointerCapture(id)) {

    joystickGaz.releasePointerCapture(id);
  }

  majValeurs();

  if (transmettre && caracEcriture) {

    derniereCommandeGaz = 0;

    // P0 prioritaire au prochain envoi.

    prochainType = 'VIT';

  } else {

    derniereCommandeGaz = null;
  }
}

joystickGaz.addEventListener('pointerdown', e => {

  if (pointeurGaz !== null) return;

  if (
    !caracEcriture ||
    etat !== 'marche' ||
    attenteArret
  ) return;

  pointeurGaz = e.pointerId;

  joystickGaz.classList.add('actif');

  joystickGaz.setPointerCapture(e.pointerId);

  deplacerGaz(e.clientY);
});

joystickGaz.addEventListener('pointermove', e => {

  if (e.pointerId === pointeurGaz) {

    deplacerGaz(e.clientY);
  }
});

joystickGaz.addEventListener('pointerup', e => {

  if (e.pointerId === pointeurGaz) {

    relacherGaz();
  }
});

joystickGaz.addEventListener('pointercancel', e => {

  if (e.pointerId === pointeurGaz) {

    relacherGaz();
  }
});

joystickGaz.addEventListener(
  'lostpointercapture',
  e => {

    if (e.pointerId === pointeurGaz) {

      relacherGaz();
    }
  }
);

// ---------- Sécurité en quittant la page ----------

document.addEventListener('visibilitychange', () => {

  if (
    document.hidden &&
    caracEcriture &&
    (
      etat === 'pret' ||
      etat === 'marche' ||
      fileEvenements.length
    )
  ) {
    urgenceJusqua =
      Date.now() + DUREE_REPETITION_URGENCE;

    envoyerEvenement('URGENCE');

    changerEtat('verrouille');
  }
});

// ---------- Démarrage ----------

afficherEcran();

journal(
  'Script version ' +
  VERSION_SCRIPT +
  ' chargé (micro:bit V4)'
);
