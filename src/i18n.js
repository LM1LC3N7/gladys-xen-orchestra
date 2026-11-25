// -----------------------------------------------------------------------------
// The texts users read (status, action results, refusals, feature names), in
// English and French. A text never quotes a token nor anything typed by the
// user that was refused.
// -----------------------------------------------------------------------------

import { FEATURES as F } from './constants.js';

/** The text of a message in a language. */
export const word = (text, language) =>
  typeof text === 'string' ? text : (text?.[language] ?? text?.en ?? '');

const both = (en, fr) => ({ en, fr });
const MAX_STATUS = 900;

const KIND_NAMES = {
  host: both('Host', 'Hôte'),
  vm: both('VM', 'VM'),
  sr: both('Storage', 'Stockage'),
  backup: both('Backup', 'Sauvegarde'),
};

export const kindName = (kind, language = 'fr') =>
  word(KIND_NAMES[kind] ?? both(kind, kind), language);

const NAMES = {
  host: {
    [F.HOST_RUNNING]: both('Running', 'En marche'),
    [F.HOST_MEMORY]: both('Memory used (%)', 'Mémoire utilisée (%)'),
  },
  vm: {
    [F.VM_RUNNING]: both('Running', 'Allumée'),
    [F.VM_STATE]: both('Power state', "État d'alimentation"),
    [F.VM_CPU]: both('CPU (%)', 'Processeur (%)'),
    [F.VM_MEMORY]: both('Memory used (%)', 'Mémoire utilisée (%)'),
    [F.VM_MEMORY_SIZE]: both('Memory size', 'Taille mémoire'),
    [F.START]: both('Start', 'Démarrer'),
    [F.SHUTDOWN]: both('Shut down', 'Arrêter'),
    [F.FORCE_OFF]: both('Force shutdown', "Forcer l'arrêt"),
    [F.REBOOT]: both('Restart', 'Redémarrer'),
  },
  sr: {
    [F.SR_USAGE]: both('Used (%)', 'Utilisé (%)'),
    [F.SR_FREE]: both('Free space', 'Espace libre'),
    [F.SR_SIZE]: both('Total space', 'Espace total'),
  },
  backup: {
    [F.BACKUP_OK]: both('Last run successful', 'Dernière exécution réussie'),
    [F.BACKUP_STATUS]: both('Last run', 'Dernière exécution'),
    [F.BACKUP_AGE]: both('Since the last success', 'Depuis la dernière réussite'),
  },
};

/** The name of a feature. */
export function featureName(kind, key, language = 'fr') {
  const name = NAMES[kind]?.[key];
  return name ? word(name, language) : key;
}

const POWER = {
  Running: both('Running', 'Allumée'),
  Halted: both('Halted', 'Arrêtée'),
  Paused: both('Paused', 'En pause'),
  Suspended: both('Suspended', 'Suspendue'),
};
/** A VM power state as a short text. */
export const powerWord = (power, language = 'fr') =>
  word(POWER[power] ?? both('Unknown', 'Inconnu'), language);

const RUN = {
  success: both('Success', 'Réussie'),
  failure: both('Failure', 'Échec'),
  interrupted: both('Interrupted', 'Interrompue'),
  skipped: both('Skipped', 'Ignorée'),
  pending: both('Running', 'En cours'),
};
/** A backup run status as a short text. */
export const statusWord = (status, language = 'fr') =>
  word(RUN[status] ?? both('Unknown', 'Inconnu'), language);

const CONFIG_ERRORS = {
  empty: both(
    'Type the address of your Xen Orchestra and a token of XO, save, then click "Trust the certificate" twice.',
    "Saisissez l'adresse de votre Xen Orchestra et un jeton de XO, enregistrez, puis cliquez deux fois sur « Faire confiance au certificat ».",
  ),
  invalid: both(
    'The Xen Orchestra address is not valid.',
    "L'adresse de Xen Orchestra n'est pas valide.",
  ),
  scheme: both(
    'The integration talks to Xen Orchestra in HTTPS only: type its address alone.',
    "L'intégration parle à Xen Orchestra en HTTPS seulement : saisissez son adresse seule.",
  ),
  credentials: both(
    'No user name nor password in the address: use a token.',
    "Pas d'identifiant ni de mot de passe dans l'adresse : utilisez un jeton.",
  ),
  path: both('Type the address alone, without a path.', "Saisissez l'adresse seule, sans chemin."),
  broadcast: both(
    'This address is not one of a server (broadcast or multicast).',
    "Cette adresse n'est pas celle d'un serveur (diffusion ou multicast).",
  ),
  'local-name': both(
    'Names in .local do not resolve in the container: type the IP address of Xen Orchestra.',
    "Les noms en .local ne sont pas résolus dans le conteneur : saisissez l'adresse IP de Xen Orchestra.",
  ),
  fingerprint: both(
    'The certificate fingerprint is not a SHA-256 one (64 hexadecimal digits).',
    "L'empreinte du certificat n'est pas une SHA-256 (64 caractères hexadécimaux).",
  ),
  'no-token': both(
    'Type an authentication token of Xen Orchestra (XO: your user, Authentication tokens).',
    "Saisissez un jeton d'authentification de Xen Orchestra (XO : votre utilisateur, Jetons d'authentification).",
  ),
  'bad-token': both(
    'This is not a token of Xen Orchestra (letters, digits, - and _ only, as XO shows it).',
    "Ce n'est pas un jeton de Xen Orchestra (lettres, caractères numériques, - et _ seulement, tel que XO l'affiche).",
  ),
};

const FAILURES = {
  nopin: both('certificate not pinned yet', 'certificat pas encore épinglé'),
  pin: both('certificate of Xen Orchestra changed', 'certificat de Xen Orchestra changé'),
  unauth: both('token not taken (HTTP 401)', 'jeton non pris (HTTP 401)'),
  forbidden: both(
    'not allowed for this user of XO (HTTP 403)',
    'non autorisé pour cet utilisateur de XO (HTTP 403)',
  ),
  rate: both('too many requests, paused', 'trop de requêtes, pause'),
  notfound: both('not found (not Xen Orchestra?)', 'introuvable (pas Xen Orchestra ?)'),
  refused: both('refused by Xen Orchestra', 'refusé par Xen Orchestra'),
  server: both('error of Xen Orchestra', 'erreur de Xen Orchestra'),
  redirect: both('redirected (not Xen Orchestra?)', 'redirigé (pas Xen Orchestra ?)'),
  network: both('Xen Orchestra unreachable', 'Xen Orchestra injoignable'),
  timeout: both('no answer in time', 'pas de réponse à temps'),
  size: both('answer too large', 'réponse trop grande'),
  format: both(
    'answer not understood (not Xen Orchestra?)',
    'réponse non comprise (pas Xen Orchestra ?)',
  ),
  aborted: both('stopped', 'arrêté'),
};

const failureWord = (err) => FAILURES[err?.kind] ?? both('error', 'erreur');

const COMMANDS = {
  [F.START]: both('Start', 'Démarrer'),
  [F.SHUTDOWN]: both('Shut down', 'Arrêter'),
  [F.FORCE_OFF]: both('Force shutdown', "Forcer l'arrêt"),
  [F.REBOOT]: both('Restart', 'Redémarrer'),
  start: both('Start', 'Démarrer'),
  clean_shutdown: both('Shut down', 'Arrêter'),
  hard_shutdown: both('Force shutdown', "Forcer l'arrêt"),
  clean_reboot: both('Restart', 'Redémarrer'),
};
const commandName = (key) => COMMANDS[key] ?? both(key, key);

export const T = {
  join(parts) {
    const out = {};
    for (const lang of ['en', 'fr']) {
      out[lang] = parts
        .map((p) => word(p, lang))
        .filter(Boolean)
        .join(' ')
        .slice(0, MAX_STATUS);
    }
    return out;
  },
  configUnread: (s) =>
    both(
      `Gladys did not give the configuration: tried again in ${s} s.`,
      `Gladys n'a pas donné la configuration : nouvel essai dans ${s} s.`,
    ),
  configError: (code) => CONFIG_ERRORS[code] ?? CONFIG_ERRORS.invalid,
  noPin: both(
    'The certificate of Xen Orchestra is not pinned yet: nothing is sent. Click "Trust the certificate" twice (or type its fingerprint).',
    "Le certificat de Xen Orchestra n'est pas encore épinglé : rien n'est envoyé. Cliquez deux fois sur « Faire confiance au certificat » (ou saisissez son empreinte).",
  ),
  pinChanged: (fp) =>
    both(
      `The certificate of Xen Orchestra changed: nothing is sent, the token neither (seen: ${fp ?? '?'}). If you renewed the certificate of XO, click "Trust the certificate" twice or type this fingerprint.`,
      `Le certificat de Xen Orchestra a changé : rien n'est envoyé, le jeton non plus (vu : ${fp ?? '?'}). Si vous avez renouvelé le certificat de XO, cliquez deux fois sur « Faire confiance au certificat » ou saisissez cette empreinte.`,
    ),
  pinNotKept: (fp) =>
    both(
      `Certificate seen (${fp}) but /data could not keep it: type this fingerprint in the configuration.`,
      `Certificat vu (${fp}) mais /data n'a pas pu le garder : saisissez cette empreinte dans la configuration.`,
    ),
  tokenRefused: both(
    'Xen Orchestra refused the token (HTTP 401: revoked, expired or mistyped): nothing is tried again until you save a new token or click Test.',
    "Xen Orchestra a refusé le jeton (HTTP 401 : révoqué, expiré ou mal saisi) : rien n'est réessayé avant que vous enregistriez un nouveau jeton ou cliquiez sur Tester.",
  ),
  paused: (min) =>
    both(
      `Xen Orchestra asked to wait (429 or 5xx): reads and commands paused for about ${min} min.`,
      `Xen Orchestra a demandé d'attendre (429 ou 5xx) : lectures et commandes en pause pour environ ${min} min.`,
    ),
  connecting: both('Connecting to Xen Orchestra...', 'Connexion à Xen Orchestra...'),
  connected: ({ hosts, vms, running, srs, jobs, interval }) =>
    both(
      `Connected: ${hosts} host(s), ${vms} VM(s) (${running} running), ${srs} storage(s), ${jobs} backup job(s); read every ${interval} s.`,
      `Connecté : ${hosts} hôte(s), ${vms} VM (${running} allumée(s)), ${srs} stockage(s), ${jobs} tâche(s) de sauvegarde ; lecture toutes les ${interval} s.`,
    ),
  overflow: both(
    'More objects than the integration reads (200 VMs, 32 hosts, 64 storages, 64 backup jobs): the others are left out.',
    "Plus d'objets que l'intégration n'en lit (200 VM, 32 hôtes, 64 stockages, 64 tâches de sauvegarde) : les autres sont laissés de côté.",
  ),
  failure: (err) => {
    if (err?.kind === 'pin') return T.pinChanged(err.fingerprint);
    const what = failureWord(err);
    return both(`Xen Orchestra: ${what.en}.`, `Xen Orchestra : ${what.fr}.`);
  },
  tokenNotKept: both(
    'The token was renewed but Gladys could not keep the new one yet (tried again every 10 min); after a restart, the token you typed is used while it is valid.',
    "Le jeton a été renouvelé mais Gladys n'a pas encore pu garder le nouveau (réessayé toutes les 10 min) ; après un redémarrage, le jeton saisi est utilisé tant qu'il est valide.",
  ),
  tokenRenewFailed: (days, err) => {
    const what = failureWord(err);
    return both(
      `The token expires in ${days} day(s) and could not be renewed (${what.en}): tried again within an hour; create a new token in XO if this lasts.`,
      `Le jeton expire dans ${days} jour(s) et n'a pas pu être renouvelé (${what.fr}) : réessayé dans l'heure ; créez un nouveau jeton dans XO si cela dure.`,
    );
  },
  dataUnreadable: both(
    '/data is unreadable: read again every 10 s; meanwhile nothing is learnt nor kept (pin), and Shut down and Force shutdown are refused.',
    "/data est illisible : relu toutes les 10 s ; en attendant, rien n'est appris ni gardé (épingle), et Arrêter et Forcer l'arrêt sont refusés.",
  ),
  badge: {
    unconfirmed: both('Last command not confirmed yet', 'Dernière commande pas encore confirmée'),
    missing: both(
      'Not in the last read of Xen Orchestra',
      'Absent de la dernière lecture de Xen Orchestra',
    ),
  },
  result: {
    sent: (key) => {
      const n = commandName(key);
      return both(
        `${n.en}: taken by Xen Orchestra; done once a read shows it.`,
        `${n.fr} : pris par Xen Orchestra ; fait quand une lecture le montre.`,
      );
    },
    unconfirmed: (key) => {
      const n = commandName(key);
      return both(
        `${n.en}: sent, without confirmation (no clear answer): never sent again by itself; reads follow.`,
        `${n.fr} : envoyé, sans confirmation (pas de réponse claire) : jamais renvoyé de lui-même ; des relectures suivent.`,
      );
    },
    refused: (key, err) => {
      const n = commandName(key);
      const what = failureWord(err);
      return both(
        `${n.en}: refused by Xen Orchestra (${what.en}, HTTP ${err?.status ?? '?'}): nothing done.`,
        `${n.fr} : refusé par Xen Orchestra (${what.fr}, HTTP ${err?.status ?? '?'}) : rien fait.`,
      );
    },
    nothingSent: (key, err) => {
      const n = commandName(key);
      const what = failureWord(err);
      return both(
        `${n.en}: not done (${what.en}): nothing sent.`,
        `${n.fr} : non fait (${what.fr}) : rien envoyé.`,
      );
    },
    alreadyRunning: both(
      'Start: the VM is already running, nothing sent.',
      'Démarrer : la VM est déjà allumée, rien envoyé.',
    ),
    alreadyHalted: both(
      'The VM is already halted, nothing sent.',
      'La VM est déjà arrêtée, rien envoyé.',
    ),
    confirmed: (action) => {
      const n = commandName(action);
      return both(`${n.en}: done, the VM reads so.`, `${n.fr} : fait, la VM se lit ainsi.`);
    },
    notApplied: (action, power) => {
      const n = commandName(action);
      const p = power ? (POWER[power] ?? both(power, power)) : both('not read', 'non lu');
      return both(
        `${n.en}: not applied yet (VM read: ${p.en}). Check in Xen Orchestra.`,
        `${n.fr} : pas encore appliqué (VM lue : ${p.fr}). Vérifiez dans Xen Orchestra.`,
      );
    },
  },
  denied: {
    unknown: both('Unknown device or feature.', 'Appareil ou fonction inconnu.'),
    readOnly: both('This feature is read only.', 'Cette fonction est en lecture seule.'),
    badValue: both('This button only takes a press.', "Ce bouton ne prend qu'un appui."),
    notConfigured: both(
      'The integration is not configured: nothing sent.',
      "L'intégration n'est pas configurée : rien envoyé.",
    ),
    shutdownOff: both(
      'Shut down is off in the configuration (Allow shutting VMs down): nothing sent.',
      "Arrêter est désactivé dans la configuration (Autoriser l'arrêt des VM) : rien envoyé.",
    ),
    force_offOff: both(
      'Force shutdown is off in the configuration (Allow forcing the shutdown): nothing sent.',
      "Forcer l'arrêt est désactivé dans la configuration (Autoriser l'arrêt forcé) : rien envoyé.",
    ),
    rebootOff: both(
      'Restart is off in the configuration (Allow restarting VMs): nothing sent.',
      'Redémarrer est désactivé dans la configuration (Autoriser le redémarrage des VM) : rien envoyé.',
    ),
    noPin: both(
      'The certificate of Xen Orchestra is not pinned: nothing sent.',
      "Le certificat de Xen Orchestra n'est pas épinglé : rien envoyé.",
    ),
    tokenRefused: both(
      'Xen Orchestra refused the token: nothing sent.',
      'Xen Orchestra a refusé le jeton : rien envoyé.',
    ),
    paused: (s) =>
      both(
        `Xen Orchestra asked to wait (429 or 5xx): nothing sent, try again in ${s} s.`,
        `Xen Orchestra a demandé d'attendre (429 ou 5xx) : rien envoyé, réessayez dans ${s} s.`,
      ),
    stopArrived: both(
      'A stop of this VM came after this command: nothing sent.',
      'Un arrêt de cette VM est arrivé après cette commande : rien envoyé.',
    ),
    stopGuard: (s) =>
      both(
        `This VM was shut down less than a minute ago: nothing sent, try again in ${s} s.`,
        `Cette VM a été arrêtée il y a moins d'une minute : rien envoyé, réessayez dans ${s} s.`,
      ),
    busy: both(
      'Another command of this VM is running: nothing sent.',
      'Une autre commande de cette VM est en cours : rien envoyé.',
    ),
    busyCancelled: both(
      'Another command of this VM is running: nothing sent; a Start of this VM not sent yet is cancelled.',
      'Une autre commande de cette VM est en cours : rien envoyé ; un Démarrer de cette VM pas encore parti est annulé.',
    ),
    spacing: (s) =>
      both(
        `One command per VM per 15 s at most: nothing sent, try again in ${s} s.`,
        `Une commande par VM toutes les 15 s au plus : rien envoyé, réessayez dans ${s} s.`,
      ),
    vmGone: both(
      'Xen Orchestra does not know this VM any more (404): nothing sent.',
      'Xen Orchestra ne connaît plus cette VM (404) : rien envoyé.',
    ),
    readFailed: (err) => {
      const what = failureWord(err);
      return both(
        `The VM could not be read (${what.en}): nothing sent.`,
        `La VM n'a pas pu être lue (${what.fr}) : rien envoyé.`,
      );
    },
    stateUnknown: both(
      'The power state of the VM could not be read: nothing sent.',
      "L'état d'alimentation de la VM n'a pas pu être lu : rien envoyé.",
    ),
    operationRunning: both(
      'An operation of Xen Orchestra is running on this VM: nothing sent.',
      'Une opération de Xen Orchestra est en cours sur cette VM : rien envoyé.',
    ),
    startState: (p) => {
      const w = POWER[p] ?? both(p, p);
      return both(
        `The VM is ${w.en.toLowerCase()}: Start refused (resume it in Xen Orchestra). Nothing sent.`,
        `La VM est ${w.fr.toLowerCase()} : Démarrer refusé (reprenez-la dans Xen Orchestra). Rien envoyé.`,
      );
    },
    notRunning: (p) => {
      const w = POWER[p] ?? both(p, p);
      return both(
        `The VM is not running (${w.en.toLowerCase()}): nothing sent.`,
        `La VM n'est pas allumée (${w.fr.toLowerCase()}) : rien envoyé.`,
      );
    },
    dataNotKept: both(
      '/data could not keep the guard of this stop: nothing sent.',
      "/data n'a pas pu garder la garde de cet arrêt : rien envoyé.",
    ),
    configChanged: both(
      'The configuration changed during the command (another address or token): nothing sent.',
      'La configuration a changé pendant la commande (autre adresse ou jeton) : rien envoyé.',
    ),
    tooLate: both(
      'Xen Orchestra answered too slowly: nothing sent (Gladys waits 5 s at most).',
      'Xen Orchestra a répondu trop lentement : rien envoyé (Gladys attend 5 s au plus).',
    ),
    unconfirmed: both(
      'Sent, without confirmation (no answer from Xen Orchestra): not sent again; reads follow.',
      'Envoyée, sans confirmation (pas de réponse de Xen Orchestra) : pas renvoyée ; des relectures suivent.',
    ),
    refusedByXo: (err) => {
      const what = failureWord(err);
      return both(
        `Refused by Xen Orchestra (${what.en}): nothing done.`,
        `Refusée par Xen Orchestra (${what.fr}) : rien fait.`,
      );
    },
    nothingSent: (err) => {
      const what = failureWord(err);
      return both(`Not done (${what.en}): nothing sent.`, `Non fait (${what.fr}) : rien envoyé.`);
    },
  },
  test: {
    noPin: (fp) =>
      both(
        `Xen Orchestra shows the certificate ${fp}; it is not pinned yet, nothing else was sent. Click "Trust the certificate" twice (or type this fingerprint).`,
        `Xen Orchestra montre le certificat ${fp} ; il n'est pas encore épinglé, rien d'autre n'a été envoyé. Cliquez deux fois sur « Faire confiance au certificat » (ou saisissez cette empreinte).`,
      ),
    paused: (message, s) =>
      both(
        `Not read now (pause, ${s} s left). ${word(message, 'en')}`,
        `Pas de lecture maintenant (pause, encore ${s} s). ${word(message, 'fr')}`,
      ),
    waiting: (message, s) =>
      both(
        `Read less than the refresh interval ago: next read in ${s} s. ${word(message, 'en')}`,
        `Lu il y a moins que l'intervalle de rafraîchissement : prochaine lecture dans ${s} s. ${word(message, 'fr')}`,
      ),
    ok: (n) =>
      both(
        `Xen Orchestra reached, token accepted: ${n} VM(s).`,
        `Xen Orchestra joint, jeton accepté : ${n} VM.`,
      ),
  },
  trust: {
    same: (fp) =>
      both(
        `This certificate is already the pinned one (${fp}).`,
        `Ce certificat est déjà celui épinglé (${fp}).`,
      ),
    typed: (fp) =>
      both(
        `The fingerprint typed in the configuration is the pin: replace it with ${fp} if you trust this one.`,
        `L'empreinte saisie dans la configuration est l'épingle : remplacez-la par ${fp} si vous faites confiance à celui-ci.`,
      ),
    confirm: (fp, first, address) =>
      both(
        `Xen Orchestra shows the certificate ${fp}. Nothing was sent. To check it, open https://${address}/ in a browser on your network and compare its SHA-256 fingerprint (certificate details). Click again within 2 minutes to trust it${first ? ' (trusted from then on: a different one later stops everything)' : ' (only if you renewed the certificate of XO)'}.`,
        `Xen Orchestra montre le certificat ${fp}. Rien n'a été envoyé. Pour le vérifier, ouvrez https://${address}/ dans un navigateur de votre réseau et comparez son empreinte SHA-256 (détails du certificat). Cliquez de nouveau dans les 2 minutes pour lui faire confiance${first ? ' (gardé ensuite : un autre plus tard arrête tout)' : ' (seulement si vous avez renouvelé le certificat de XO)'}.`,
      ),
    done: (fp) =>
      both(
        `Certificate ${fp} trusted: Xen Orchestra is read now.`,
        `Certificat ${fp} approuvé : Xen Orchestra est lu maintenant.`,
      ),
  },
};
