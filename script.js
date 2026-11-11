
{// ---------- Bluetooth micro:bit : connexion et pilotage de la barre ----------
const VERSION_SCRIPT = 3;

const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // écriture téléphone -> micro:bit
const $ = id => document.getElementById(id);

let appareil = null;
let caracEcriture = null;
let enConnexion = false;
let deconnexionVoulue = false;
let liaisonPerdue = false;
let enEcriture = false;
let commandeEnAttente = null;
let generationLiaison = 0;

function journal(texte) {
  const heure = new Date().toLocaleTimeString('fr-FR');
  const zone = $('journal');
  zone.textContent = (heure + '  ' + texte + '\n' + zone.textContent).slice(0, 6000);
}

function afficherLiaison() {
  const connecte = caracEcriture !== null;
  document.body.dataset.perdue = liaisonPerdue ? '1' : '0';
  $('pastille').textContent = enConnexion ? 'Connexion…'
    : connecte ? 'Connecté'
    : liaisonPerdue ? 'Liaison perdue'
    : 'Non connecté';
  $('lienTxt').textContent = connecte ? 'Bluetooth : connecté' : 'Bluetooth : non connecté';
  $('actTxt').textContent = enConnexion ? 'Connexion…' : connecte ? 'Se déconnecter' : 'Se connecter';
  $('act').disabled = enConnexion;
  $('testEnvoi').disabled = !connecte;
}

function viderEnvois() {
  generationLiaison++;
  commandeEnAttente = null;
}

function surDeconnexion(e) {
  // Ignore les événements provenant d'un ancien appareil.
  if (e && e.target !== appareil) return;
  const etaitConnecte = caracEcriture !== null;
  caracEcriture = null;
  viderEnvois();
  liaisonPerdue = etaitConnecte && !deconnexionVoulue;
  journal(liaisonPerdue ? 'Liaison perdue' : 'Déconnecté');
  deconnexionVoulue = false;
  relacherBarre(false);
  afficherLiaison();
}

async function connecter() {
  if (enConnexion || caracEcriture) return;
  if (!navigator.bluetooth) {
    journal('Web Bluetooth indisponible : utilise un navigateur compatible');
    return;
  }
  enConnexion = true;
  afficherLiaison();
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
    if (!canal.properties.write && !canal.properties.writeWithoutResponse) {
      throw new Error("Le canal UART ne permet pas l'écriture");
    }
    // Ne publier la connexion qu'une fois toute l'initialisation réussie.
    if (appareil && appareil !== candidat) {
      appareil.removeEventListener('gattserverdisconnected', surDeconnexion);
    }
    appareil = candidat;
    appareil.addEventListener('gattserverdisconnected', surDeconnexion);
    caracEcriture = canal;
    deconnexionVoulue = false;
    liaisonPerdue = false;
    viderEnvois();
    journal("Canal d'écriture : " + canal.uuid.slice(0, 8));
    journal('Connecté à ' + (appareil.name || 'micro:bit'));
  } catch (e) {
    journal(e.name === 'NotFoundError' ? 'Aucun appareil choisi' : 'Échec : ' + e.message);
    caracEcriture = null;
    viderEnvois();
    if (candidat && candidat.gatt.connected) candidat.gatt.disconnect();
    if (candidat && candidat === appareil) {
      candidat.removeEventListener('gattserverdisconnected', surDeconnexion);
      appareil = null;
    }
  } finally {
    enConnexion = false;
    afficherLiaison();
  }
}

function deconnecter() {
  if (!appareil || !appareil.gatt.connected) return;
  deconnexionVoulue = true;
  // Bloque immédiatement toute nouvelle commande pendant la déconnexion.
  caracEcriture = null;
  viderEnvois();
  relacherBarre(false);
  afficherLiaison();
  appareil.gatt.disconnect();
}

// Une seule écriture à la fois ; seule la commande la plus récente attend son tour.
// On ne conserve pas une longue file de positions devenues obsolètes.
async function envoyer(texte) {
  if (!caracEcriture) return;
  commandeEnAttente = texte;
  if (enEcriture) return;
  enEcriture = true;
  const generation = generationLiaison;
  const canal = caracEcriture;
  try {
    while (commandeEnAttente !== null && generation === generationLiaison && caracEcriture === canal) {
      const message = commandeEnAttente;
      commandeEnAttente = null;
      const octets = new TextEncoder().encode(message + '\n');
      if (canal.properties.writeWithoutResponse) {
        await canal.writeValueWithoutResponse(octets);
      } else {
        await canal.writeValue(octets);
      }
      if (generation === generationLiaison) journal('Envoyé : ' + message);
    }
  } catch (e) {
    journal("Erreur d'envoi : " + e.message);
    commandeEnAttente = null;
  } finally {
    enEcriture = false;
    // Une nouvelle connexion peut avoir ajouté une commande pendant la fin d'une ancienne écriture.
    if (commandeEnAttente !== null && caracEcriture && generation !== generationLiaison) {
      const dernierMessage = commandeEnAttente;
      commandeEnAttente = null;
      envoyer(dernierMessage);
    }
  }
}

// ---------- Boutons existants ----------
$('act').addEventListener('click', () => {
  if (enConnexion) return;
  if (caracEcriture) deconnecter();
  else connecter();
});
$('testEnvoi').addEventListener('click', () => envoyer('bonjour'));

// ---------- Pilotage de la barre ----------
const joystickBarre = $('barre');
const boutonBarre = joystickBarre.querySelector('.knob');
const affichageBarre = $('vBar');
let commandeBarre = 0;
let pointeurBarre = null;
let derniereCommandeBarre = null;

function deplacerBarre(positionX) {
  const rect = joystickBarre.getBoundingClientRect();
  const course = (rect.width - boutonBarre.offsetWidth) / 2;
  if (course <= 0) return;
  let deplacement = positionX - (rect.left + rect.width / 2);
  deplacement = Math.max(-course, Math.min(course, deplacement));
  boutonBarre.style.transform = `translateX(${deplacement}px)`;
  commandeBarre = Math.round((deplacement / course) * 100);
  affichageBarre.textContent = commandeBarre;
  if (commandeBarre !== derniereCommandeBarre) {
    derniereCommandeBarre = commandeBarre;
    envoyer('BARRE:' + commandeBarre);
  }
}

joystickBarre.addEventListener('pointerdown', e => {
  if (pointeurBarre !== null) return;
  if (!caracEcriture) {
    journal('Connecte la micro:bit avant de piloter la barre');
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
  if (joystickBarre.hasPointerCapture(id)) joystickBarre.releasePointerCapture(id);
  if (transmettre && caracEcriture) {
    derniereCommandeBarre = 0;
    envoyer('BARRE:0');
  } else {
    derniereCommandeBarre = null;
  }
}

joystickBarre.addEventListener('pointerup', e => {
  if (e.pointerId === pointeurBarre) relacherBarre();
});
joystickBarre.addEventListener('pointercancel', e => {
  if (e.pointerId === pointeurBarre) relacherBarre();
});
joystickBarre.addEventListener('lostpointercapture', e => {
  if (e.pointerId === pointeurBarre) relacherBarre();
});

afficherLiaison();
journal('Script version ' + VERSION_SCRIPT + ' chargé');
