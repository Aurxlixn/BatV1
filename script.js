// ---------- Bluetooth micro:bit : connexion seule ----------
const VERSION_SCRIPT = 2;

// Service Bluetooth UART de la micro:bit
const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';

const $ = id => document.getElementById(id);

let appareil = null;
let caracEcriture = null;       // non nul = connecté
let enConnexion = false;
let enEcriture = false;
let deconnexionVoulue = false;
let liaisonPerdue = false;

// Journal : les messages les plus récents en haut
function journal(texte) {
  const heure = new Date().toLocaleTimeString('fr-FR');
  $('journal').textContent = heure + '  ' + texte + '\n' + $('journal').textContent;
}

// Met à jour l'écran selon l'état de la liaison
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

// Appelée quand la liaison tombe (micro:bit éteinte, hors de portée, déconnexion voulue...)
function surDeconnexion() {
  const etaitConnecte = caracEcriture !== null;
  caracEcriture = null;
  liaisonPerdue = etaitConnecte && !deconnexionVoulue;
  journal(liaisonPerdue ? 'Liaison perdue' : 'Déconnecté');
  deconnexionVoulue = false;
  afficherLiaison();
}

async function connecter() {
  if (enConnexion) return;
  if (!navigator.bluetooth) {
    journal('Web Bluetooth indisponible : utilise Bluefy (iPhone) ou Chrome (Mac)');
    return;
  }
  enConnexion = true;
  afficherLiaison();
  try {
    journal('Recherche de la micro:bit...');
    appareil = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BBC micro:bit' }],
      optionalServices: [UART_SERVICE]
    });
    appareil.removeEventListener('gattserverdisconnected', surDeconnexion);
    appareil.addEventListener('gattserverdisconnected', surDeconnexion);

    const serveur = await appareil.gatt.connect();
    const service = await serveur.getPrimaryService(UART_SERVICE);

    // On prend le canal qui accepte l'écriture (son code varie selon les cartes)
    const caracs = await service.getCharacteristics();
    const choisi = caracs.find(c => c.properties.write || c.properties.writeWithoutResponse);
    if (!choisi) throw new Error("Aucun canal d'écriture trouvé");
    caracEcriture = choisi;
    journal("Canal d'écriture : " + choisi.uuid.slice(0, 8));

    liaisonPerdue = false;
    journal('Connecté à ' + appareil.name);
  } catch (e) {
    journal(e.name === 'NotFoundError' ? 'Aucun appareil choisi' : 'Échec : ' + e.message);
    caracEcriture = null;
    if (appareil && appareil.gatt.connected) appareil.gatt.disconnect();
  } finally {
    enConnexion = false;
    afficherLiaison();
  }
}

function deconnecter() {
  if (appareil && appareil.gatt.connected) {
    deconnexionVoulue = true;
    appareil.gatt.disconnect();
  }
}

// Envoie une ligne de texte (terminée par un retour à la ligne)
async function envoyer(texte) {
  if (!caracEcriture) return;
  if (enEcriture) { journal('Envoi précédent pas fini, ignoré'); return; }
  enEcriture = true;
  try {
    const octets = new TextEncoder().encode(texte + '\n');
    if (caracEcriture.properties.writeWithoutResponse) {
      await caracEcriture.writeValueWithoutResponse(octets);
    } else {
      await caracEcriture.writeValue(octets);
    }
    journal('Envoyé : ' + texte);
  } catch (e) {
    journal("Erreur d'envoi : " + e.message);
  } finally {
    enEcriture = false;
  }
}

// ---------- Boutons ----------
$('act').addEventListener('click', () => {
  if (caracEcriture) deconnecter();
  else connecter();
});
$('testEnvoi').addEventListener('click', () => envoyer('bonjour'));


 // ---------- Pilotage de la barre ----------
const joystickBarre = $('barre');
const boutonBarre = joystickBarre.querySelector('.knob');
const affichageBarre = $('vBar');

let commandeBarre = 0;
let barreActive = false;

// Déplace visuellement le joystick et calcule la commande
function deplacerBarre(positionX) {
  const rect = joystickBarre.getBoundingClientRect();

  // Course maximale du joystick, en tenant compte du bouton
  const course = (rect.width - boutonBarre.offsetWidth) / 2;

  // Position horizontale par rapport au centre du joystick
  let deplacement = positionX - (rect.left + rect.width / 2);

  // Limitation aux extrémités
  deplacement = Math.max(-course, Math.min(course, deplacement));

  // Déplacement visuel du bouton
  boutonBarre.style.transform = `translateX(${deplacement}px)`;

  // Conversion en commande de -100 à +100
  commandeBarre = Math.round((deplacement / course) * 100);

  // Affichage de la commande sur le site
  affichageBarre.textContent = commandeBarre;

  // Transmission Bluetooth
  envoyer('BARRE:' + commandeBarre);
}

// Appui sur le joystick
joystickBarre.addEventListener('pointerdown', (e) => {
  if (!caracEcriture) {
    journal('Connecte la micro:bit avant de piloter la barre');
    return;
  }

  barreActive = true;
  joystickBarre.classList.remove('off');
  joystickBarre.classList.add('actif');

  joystickBarre.setPointerCapture(e.pointerId);
  deplacerBarre(e.clientX);
});

// Déplacement du doigt
joystickBarre.addEventListener('pointermove', (e) => {
  if (!barreActive) return;

  deplacerBarre(e.clientX);
});

// Relâchement du doigt
function relacherBarre() {
  if (!barreActive) return;

  barreActive = false;
  commandeBarre = 0;

  // Retour visuel au neutre
  boutonBarre.style.transform = 'translateX(0px)';
  affichageBarre.textContent = '0';

  joystickBarre.classList.remove('actif');
  joystickBarre.classList.add('off');

  // Retour du servo au neutre
  envoyer('BARRE:0');
}

joystickBarre.addEventListener('pointerup', relacherBarre);
joystickBarre.addEventListener('pointercancel', relacherBarre);

afficherLiaison();
journal('Script version ' + VERSION_SCRIPT + ' chargé');
