// ---------- Bluetooth micro:bit : connexion seule ----------

// Service Bluetooth UART de la micro:bit
const UART_SERVICE  = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_ECRITURE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';   // page -> micro:bit

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
    caracEcriture = await service.getCharacteristic(UART_ECRITURE);

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
    if (caracEcriture.writeValueWithoutResponse) {
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

afficherLiaison();
