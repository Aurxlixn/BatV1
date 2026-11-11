
 // ---------- Bluetooth micro:bit : connexion, barre et états ----------
const VERSION_SCRIPT = 5;

const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

const $ = id => document.getElementById(id);

// ---------- Bluetooth ----------
let appareil = null;
let caracEcriture = null;
let enConnexion = false;
let liaisonPerdue = false;
let enEcriture = false;
let commandeEnAttente = null;
let generationLiaison = 0;

// ---------- États ----------
const ETATS = {
  NON_CONNECTE: 'Non connecté',
  VERROUILLE: 'Verrouillé',
  PRET: 'Prêt',
  EN_MARCHE: 'En marche'
};

let etat = ETATS.NON_CONNECTE;

// ---------- Journal ----------
function journal(texte) {
  const heure = new Date().toLocaleTimeString('fr-FR');
  const zone = $('journal');

  zone.textContent = (
    heure + '  ' + texte + '\n' + zone.textContent
  ).slice(0, 6000);
}

// ---------- Affichage ----------
function afficherEtat() {
  const connecte = caracEcriture !== null;

  document.body.dataset.perdue = liaisonPerdue ? '1' : '0';
  document.body.dataset.etat = etat;

  $('pastille').textContent = enConnexion
    ? 'Connexion…'
    : etat;

  $('lienTxt').textContent = connecte
    ? 'Bluetooth : connecté'
    : 'Bluetooth : non connecté';

  if (enConnexion) {
    $('actTxt').textContent = 'Connexion…';
  } else if (etat === ETATS.NON_CONNECTE) {
    $('actTxt').textContent = 'Se connecter';
  } else if (etat === ETATS.VERROUILLE) {
    $('actTxt').textContent = 'Maintenir 1 seconde pour armer';
  } else if (etat === ETATS.PRET) {
    $('actTxt').textContent = 'Double appui pour démarrer';
  } else {
    $('actTxt').textContent = 'Double appui pour arrêter';
  }

  $('act').disabled = enConnexion;
  $('testEnvoi').disabled = !connecte;
}

function changerEtat(nouvelEtat) {
  if (etat === nouvelEtat) return;

  etat = nouvelEtat;
  journal('État : ' + etat);
  afficherEtat();
}

// ---------- Gestion des envois ----------
function viderEnvois() {
  generationLiaison++;
  commandeEnAttente = null;
}

// ---------- Déconnexion ----------
function surDeconnexion(e) {
  if (e && e.target !== appareil) return;

  const etaitConnecte = caracEcriture !== null;

  caracEcriture = null;
  viderEnvois();

  liaisonPerdue = etaitConnecte;

  journal(
    liaisonPerdue ? 'Liaison perdue' : 'Déconnecté'
  );

  relacherBarre(false);
  reinitialiserBoutonPrincipal();
  changerEtat(ETATS.NON_CONNECTE);
  afficherEtat();
}

// ---------- Connexion ----------
async function connecter() {
  if (enConnexion || caracEcriture) return;

  if (!navigator.bluetooth) {
    journal(
      'Web Bluetooth indisponible : utilise un navigateur compatible'
    );
    return;
  }

  enConnexion = true;
  afficherEtat();

  let candidat = null;

  try {
    journal('Recherche de la micro:bit...');

    candidat = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [UART_SERVICE]
    });

    const serveur = await candidat.gatt.connect();
    const service = await serveur.getPrimaryService(UART_SERVICE);
    const canal = await service.getCharacteristic(UART_RX);

    if (
      !canal.properties.write &&
      !canal.properties.writeWithoutResponse
    ) {
      throw new Error(
        "Le canal UART ne permet pas l'écriture"
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
    liaisonPerdue = false;

    viderEnvois();

    journal(
      "Canal d'écriture : " + canal.uuid.slice(0, 8)
    );

    journal(
      'Connecté à ' + (appareil.name || 'micro:bit')
    );

    changerEtat(ETATS.VERROUILLE);

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

    changerEtat(ETATS.NON_CONNECTE);

  } finally {
    enConnexion = false;
    afficherEtat();
  }
}

// ---------- Envoi Bluetooth ----------
// Une seule écriture à la fois.
// La dernière commande remplace les anciennes commandes en attente.

async function envoyer(texte) {
  if (!caracEcriture) return;

  commandeEnAttente = texte;

  if (enEcriture) return;

  enEcriture = true;

  const generation = generationLiaison;
  const canal = caracEcriture;

  try {
    while (
      commandeEnAttente !== null &&
      generation === generationLiaison &&
      caracEcriture === canal
    ) {
      const message = commandeEnAttente;
      commandeEnAttente = null;

      const octets = new TextEncoder().encode(
        message + '\n'
      );

      if (canal.properties.writeWithoutResponse) {
        await canal.writeValueWithoutResponse(octets);
      } else {
        await canal.writeValue(octets);
      }

      if (generation === generationLiaison) {
        journal('Envoyé : ' + message);
      }
    }

  } catch (e) {
    journal("Erreur d'envoi : " + e.message);
    commandeEnAttente = null;

  } finally {
    enEcriture = false;

    if (
      commandeEnAttente !== null &&
      caracEcriture &&
      generation !== generationLiaison
    ) {
      const dernierMessage = commandeEnAttente;
      commandeEnAttente = null;
      envoyer(dernierMessage);
    }
  }
}

// ---------- Bouton principal ----------
const boutonPrincipal = $('act');

const DUREE_ARMEMENT = 1000;
const DELAI_DOUBLE_APPUI = 350;

let pointeurPrincipal = null;
let minuteurArmement = null;
let armementEffectue = false;
let dernierAppui = 0;

function reinitialiserBoutonPrincipal() {
  clearTimeout(minuteurArmement);

  minuteurArmement = null;
  pointeurPrincipal = null;
  armementEffectue = false;
  dernierAppui = 0;
}

boutonPrincipal.addEventListener('pointerdown', e => {
  if (enConnexion || pointeurPrincipal !== null) return;

  if (e.pointerType === 'mouse' && e.button !== 0) return;

  pointeurPrincipal = e.pointerId;
  armementEffectue = false;

  if (etat === ETATS.VERROUILLE) {
    minuteurArmement = setTimeout(() => {
      if (
        pointeurPrincipal === e.pointerId &&
        caracEcriture &&
        etat === ETATS.VERROUILLE
      ) {
        armementEffectue = true;

        // Nouvelle commande Bluetooth : armement
        envoyer('ARMER');

        changerEtat(ETATS.PRET);
      }
    }, DUREE_ARMEMENT);
  }
});

boutonPrincipal.addEventListener('pointerup', e => {
  if (e.pointerId !== pointeurPrincipal) return;

  clearTimeout(minuteurArmement);
  minuteurArmement = null;
  pointeurPrincipal = null;

  if (armementEffectue) {
    armementEffectue = false;
    dernierAppui = 0;
    return;
  }

  if (enConnexion) return;

  // Un appui simple connecte la micro:bit.
  if (etat === ETATS.NON_CONNECTE) {
    dernierAppui = 0;
    connecter();
    return;
  }

  // En état Verrouillé, seul l'appui long agit.
  if (etat === ETATS.VERROUILLE) {
    dernierAppui = 0;
    return;
  }

  // Double appui : Prêt <-> En marche.
  const maintenant = Date.now();

  if (
    dernierAppui !== 0 &&
    maintenant - dernierAppui <= DELAI_DOUBLE_APPUI
  ) {
    dernierAppui = 0;

    if (etat === ETATS.PRET) {
      // Nouvelle commande Bluetooth : marche
      envoyer('MARCHE');

      changerEtat(ETATS.EN_MARCHE);

    } else if (etat === ETATS.EN_MARCHE) {
      // Nouvelle commande Bluetooth : arrêt
      envoyer('ARRET');

      changerEtat(ETATS.PRET);
    }

  } else {
    dernierAppui = maintenant;
  }
});

boutonPrincipal.addEventListener('pointercancel', e => {
  if (e.pointerId === pointeurPrincipal) {
    reinitialiserBoutonPrincipal();
  }
});

boutonPrincipal.addEventListener('lostpointercapture', e => {
  if (e.pointerId === pointeurPrincipal) {
    reinitialiserBoutonPrincipal();
  }
});

// Empêche le menu contextuel pendant l'appui long.
boutonPrincipal.addEventListener('contextmenu', e => {
  e.preventDefault();
});

// ---------- Bouton de test ----------
$('testEnvoi').addEventListener('click', () => {
  envoyer('bonjour');
});

// ---------- Pilotage de la barre ----------
const joystickBarre = $('barre');
const boutonBarre = joystickBarre.querySelector('.knob');
const affichageBarre = $('vBar');

let commandeBarre = 0;
let pointeurBarre = null;
let derniereCommandeBarre = null;

function deplacerBarre(positionX) {
  const rect = joystickBarre.getBoundingClientRect();

  const course = (
    rect.width - boutonBarre.offsetWidth
  ) / 2;

  if (course <= 0) return;

  let deplacement = positionX - (
    rect.left + rect.width / 2
  );

  deplacement = Math.max(
    -course,
    Math.min(course, deplacement)
  );

  boutonBarre.style.transform =
    `translateX(${deplacement}px)`;

  commandeBarre = Math.round(
    (deplacement / course) * 100
  );

  affichageBarre.textContent = commandeBarre;

  if (commandeBarre !== derniereCommandeBarre) {
    derniereCommandeBarre = commandeBarre;
    envoyer('BARRE:' + commandeBarre);
  }
}

joystickBarre.addEventListener('pointerdown', e => {
  if (pointeurBarre !== null) return;

  if (!caracEcriture) {
    journal(
      'Connecte la micro:bit avant de piloter la barre'
    );
    return;
  }

  pointeurBarre = e.pointerId;

  joystickBarre.classList.remove('off');
  joystickBarre.classList.add('actif');

  joystickBarre.setPointerCapture(e.pointerId);

  deplacerBarre(e.clientX);
});

joystickBarre.addEventListener('pointermove', e => {
  if (e.pointerId !== pointeurBarre) return;

  deplacerBarre(e.clientX);
});

function relacherBarre(transmettre = true) {
  if (pointeurBarre === null) return;

  const id = pointeurBarre;
  pointeurBarre = null;

  commandeBarre = 0;

  boutonBarre.style.transform = 'translateX(0px)';
  affichageBarre.textContent = '0';

  joystickBarre.classList.remove('actif');
  joystickBarre.classList.add('off');

  if (joystickBarre.hasPointerCapture(id)) {
    joystickBarre.releasePointerCapture(id);
  }

  if (transmettre && caracEcriture) {
    derniereCommandeBarre = 0;
    envoyer('BARRE:0');
  } else {
    derniereCommandeBarre = null;
  }
}

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

// ---------- Initialisation ----------
afficherEtat();
journal('Script version ' + VERSION_SCRIPT + ' chargé');
