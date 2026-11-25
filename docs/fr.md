# Xen Orchestra / XCP-ng

Suivez vos hôtes XCP-ng, vos VM, vos stockages et vos sauvegardes depuis Gladys, et démarrez une VM, par
l'API REST de [Xen Orchestra](https://xen-orchestra.com/) (XO), en HTTPS sur votre réseau. Intégration non
officielle, sans lien avec Vates, Xen Orchestra ni XCP-ng. **Jamais testé avec un vrai appareil** : écrit
d'après la documentation officielle de l'API REST (https://docs.xen-orchestra.com/restapi) et le Swagger
fourni par XO, testé contre un Xen Orchestra simulé et, pour les lectures et le jeton, contre un vrai Xen
Orchestra en conteneur sans hyperviseur (aucune VM réelle démarrée ni arrêtée).

## Ce que vous obtenez

Des appareils à ajouter depuis la Découverte (une fois le Scan lancé) :

| Appareil   | Fonctions                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hôte       | en marche (binaire), mémoire utilisée (%)                                                                                                                         |
| VM         | allumée (binaire), état d'alimentation (texte), processeur (%), mémoire utilisée (%), taille mémoire (Mo) ; boutons Démarrer, Arrêter, Forcer l'arrêt, Redémarrer |
| Stockage   | utilisé (%), espace libre et total (Go) ; les bibliothèques ISO et les supports amovibles sont laissés de côté                                                    |
| Sauvegarde | dernière exécution réussie (binaire), dernière exécution (texte), heures depuis la dernière réussite                                                              |

- Le processeur et la mémoire utilisée viennent des statistiques de XAPI : 10 VM allumées au plus par
  lecture, à tour de rôle (avec 30 VM allumées, chacune est relue toutes les 3 lectures). Un échantillon de
  plus de 5 minutes (selon l'heure de XO) n'est pas publié. Sans les outils invités, la mémoire utilisée
  reste inconnue (jamais 0).
- Les sauvegardes : les exécutions démarrées dans les 8 derniers jours (selon l'heure de XO). Une tâche
  sans réussite dans cette fenêtre a une durée depuis la dernière réussite inconnue.
- Au plus 32 hôtes, 200 VM, 64 stockages, 64 tâches de sauvegarde : au-delà, le statut le dit.
- Les identifiants des appareils sont les UUID donnés par XO (une VM renommée reste le même appareil).

## Installation

1. Dans Xen Orchestra, créez un **jeton d'authentification** (votre utilisateur, Jetons d'authentification,
   ou `xo-cli create-token`). Préférez un utilisateur non administrateur qui ne voit que les VM voulues dans
   Gladys (droits de XO).
2. Dans Gladys, ouvrez l'intégration, saisissez l'**adresse** de Xen Orchestra (comme dans votre
   navigateur, ex. `192.168.1.30` ; HTTPS uniquement ; `:port` si ce n'est pas 443) et le **jeton**, puis
   enregistrez.
3. Cliquez deux fois sur **Faire confiance au certificat**. Le premier clic montre l'empreinte SHA-256 du
   certificat présenté et n'envoie rien d'autre. Comparez-la avec celle que votre navigateur affiche pour
   `https://<adresse>/` (détails du certificat), puis cliquez de nouveau dans les 2 minutes. Vous pouvez
   aussi saisir l'empreinte dans la configuration. Ensuite, un autre certificat arrête tout (le jeton ne lui
   est pas envoyé) jusqu'à ce que vous lui fassiez confiance de la même façon.
4. Lancez un **Scan** dans la Découverte et créez les appareils voulus.

## Le jeton

- Il est gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à Xen Orchestra (dans le cookie
  `authenticationToken`) et seulement une fois son certificat vérifié. Il n'apparaît ni dans les journaux,
  ni dans `/data`, ni dans le statut.
- **Renouvellement** : toutes les 12 h, l'intégration lit la date d'expiration du jeton (selon l'heure de
  XO, jamais celle du conteneur). Quand il reste moins de la moitié de sa durée, ou moins de 7 jours, elle
  demande à XO un nouveau jeton avec le jeton actuel (méthode documentée par XO, sans mot de passe) et le
  donne à Gladys, qui le garde à la place de l'ancien. L'ancien reste valable dans XO jusqu'à sa propre
  expiration (vous pouvez le révoquer dans XO). Si Gladys ne peut pas garder le nouveau, il est utilisé en
  mémoire et réessayé toutes les 10 minutes ; après un redémarrage, le jeton saisi sert tant qu'il est
  valable. Sans heure lisible de XO, le jeton n'est jamais considéré comme expirant.
- **Refus** : si XO répond 401 dans sa propre enveloppe à la lecture des VM, le jeton est refusé : rien
  n'est réessayé (une marque de 6 bits, jamais le jeton, est gardée dans `/data`) jusqu'à l'enregistrement
  d'un autre jeton ou un clic sur **Tester la connexion**. Un 401 ou 403 sur une autre route (hôtes,
  sauvegardes, statistiques, liste des jetons) ou un 401 sans l'enveloppe de XO (un proxy) n'est pas un
  refus.

## Les boutons des VM

- **Démarrer** est permis sans option. Une VM en pause ou suspendue n'est pas démarrée (reprenez-la dans XO).
- **Arrêter** (arrêt propre, outils invités nécessaires), **Forcer l'arrêt** (comme débrancher la prise) et
  **Redémarrer** (redémarrage propre) sont désactivés par défaut, une option chacun.
- Ce sont des boutons, pas des interrupteurs : un « tout éteindre » d'un assistant vocal ou d'une scène ne
  les atteint pas.
- Chaque commande relit la VM après le clic et décide sur cette lecture (déjà allumée : rien envoyé ; déjà
  arrêtée : rien envoyé ; opération XO en cours : refus). L'option, la pause, un arrêt plus récent de la
  même VM et la garde sont revérifiés juste avant le premier octet. Une commande à la fois par VM, une par
  VM toutes les 15 s ; une autre VM n'est pas retenue.
- Après Arrêter ou Forcer l'arrêt, **Démarrer** cette VM est refusé pendant 1 minute. Cette garde est écrite
  dans `/data` avant l'envoi ; si `/data` ne peut pas l'écrire, l'arrêt est refusé (rien envoyé). Un arrêt
  qui n'est pas parti retire sa garde.
- Un arrêt de la VM annule un Démarrer de la même VM qui n'est pas encore parti (même si cet arrêt est
  lui-même refusé parce que son option est désactivée ou qu'une commande est en cours).
- Une commande est envoyée dans les 3,5 s après le clic ou pas du tout (Gladys attend 5 s). Elle n'est dite
  **faite** que lorsqu'une lecture suivante le montre (état d'alimentation, ou nouvelle heure de démarrage
  pour un redémarrage) ; des relectures suivent (5 s, 20 s, puis plus espacées). Une lecture égale à l'état
  d'avant est « pas encore appliqué ». Partie sans réponse : « envoyée, sans confirmation », jamais renvoyée
  d'elle-même. Pas partie : « rien envoyé ». Le résultat s'affiche dans le statut de l'intégration pendant
  10 minutes.
- Refus de Démarrer : intégration non configurée, certificat non épinglé, jeton refusé, pause demandée par
  XO, arrêt plus récent de la même VM, garde d'une minute après un arrêt, commande en cours sur la VM, moins
  de 15 s depuis la dernière commande de la VM, VM illisible ou inconnue de XO, opération XO en cours, VM en
  pause ou suspendue, configuration changée pendant la commande (autre adresse ou jeton), réponse trop
  lente.
- Refus d'Arrêter, Forcer l'arrêt, Redémarrer : les mêmes (sauf la garde), plus l'option désactivée,
  `/data` qui ne garde pas la garde (Arrêter, Forcer l'arrêt) et une VM qui n'est pas allumée (Arrêter,
  Redémarrer).

## Pauses et lectures

- La lecture des VM est la lecture principale ; les hôtes, les stockages, les sauvegardes, les statistiques
  et le jeton sont des lectures secondaires : leur échec n'arrête pas les autres (sauf une pause ou un
  certificat changé, ci-dessous) et elles sont espacées (jusqu'à 1 h) tant qu'elles échouent.
- Un 429, ou un 5xx qui n'est pas une erreur de XO elle-même (proxy, 502, 503, 504), met en pause lectures
  et commandes (1 min à 6 h, `Retry-After` respecté, gardé dans `/data`). Une erreur 500 de XAPI sur une VM
  ne met rien en pause.
- Jamais plus vite que l'intervalle après un redémarrage, une reconnexion à Gladys, un Scan ou un clic sur
  Tester (qui ne réessaie tout de suite qu'un jeton refusé) ; seuls une autre adresse ou un autre jeton
  enregistré, ou un certificat approuvé, lisent tout de suite. Les relectures qui suivent une commande ne
  comptent pas.

## Ce qui n'est pas fait

- Pas de création, suppression, migration, instantané ni restauration ; pas de commande sur les hôtes.
- Pas d'événements en temps réel (SSE) : lecture à l'intervalle.
- Pas de nom d'utilisateur ni de mot de passe : un jeton seulement.
