// Push overlay (issues #544, #629). importScripts'd INTO the Workbox-generated
// service worker (see vite.config.ts workbox.importScripts) — a classic worker
// script, not a module. The generated SW still owns precaching + the #141
// auto-update flow (skipWaiting/clientsClaim/deferred reload); this file adds ONLY
// the push + notificationclick listeners, so that contract is untouched.
//
// Five notification kinds ride this one path, distinguished by `payload.type`:
//   - 'cook-timer'        (#544) — deep-links via `url` since #1127, `sessionId` FALLBACK, has an in-app equivalent
//   - 'shopping-reminder' (#629) — deep-links via `url`, has none
//   - 'batch-stage'       (#812) — deep-links via `url`, has none
//   - 'kitchen-timer'     (#842) — deep-links via `url`, has an in-app equivalent
//   - 'batch-readings'    (#1406) — the weekly "what is drying" nudge; deep-links via `url` to the batches LIST, has none
// Everything that differs between them is payload-driven; nothing here is
// hard-coded per feature except the foreground rule below and the fallback copy
// each kind uses when a payload arrives without any.

// Fallback copy PER KIND, used only when the server sent none (or the payload could
// not be parsed at all). It has to be per kind: a batch reminder that failed to
// carry its stage name must not announce itself as a finished cook timer, which is
// what a single shared default did. `type` defaults to 'cook-timer' below, so an
// unreadable payload lands on the #544 copy exactly as it always has.
// SALT_-prefixed because this file is importScripts'd INTO the Workbox-generated
// service worker: its `var`s land in that worker's shared global scope, and an
// unprefixed name could collide with Workbox's own.
var SALT_FALLBACK_COPY = {
  'cook-timer': {
    title: 'Timer finished',
    body: 'A cook timer just finished.',
    tag: 'cook-timer',
  },
  'shopping-reminder': {
    title: 'Shopping tomorrow',
    body: 'Add anything missing to the list.',
    tag: 'shopping-reminder',
  },
  'batch-stage': {
    title: 'A batch stage is due',
    body: 'Open the batch to see what is next.',
    tag: 'batch-stage',
  },
  'kitchen-timer': {
    title: 'Timer finished',
    body: 'A kitchen timer just finished.',
    tag: 'kitchen-timer',
  },
  // A FIFTH KIND rather than a reuse of 'batch-stage' (#1406). A weekly nudge whose
  // payload failed to parse would otherwise announce itself as "A batch stage is due",
  // which is a lie: nothing is due, something wants weighing. The fallback cannot know
  // WHAT is drying, so it says the one thing that is true either way.
  'batch-readings': {
    title: 'Something is drying',
    body: 'Weigh it and add a note.',
    tag: 'batch-readings',
  },
};

self.addEventListener('push', function (event) {
  // Copy is entirely server-chosen, and for a cook timer it IS user content: the
  // timer's label and the recipe's title ("Simmer the sauce" / "Shepherd's pie"),
  // which #544 deliberately withheld and #680 deliberately restored. Nothing here
  // inspects or reformats it — render what you are given, fall back if it is absent.
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_e) {
    payload = {};
  }
  var type = payload.type || 'cook-timer';
  var fallback = SALT_FALLBACK_COPY[type] || SALT_FALLBACK_COPY['cook-timer'];
  var sessionId = payload.sessionId || null;
  var url = payload.url || null;
  var title = payload.title || fallback.title;
  var body = payload.body || fallback.body;
  var tag = payload.tag || fallback.tag;
  // Payload-driven (#629): a cook timer re-buzzes on every delivery, but a
  // duplicate shopping nudge must REPLACE the first silently — which, together
  // with the date-keyed tag, is what lets the reminder skip an exactly-once
  // ledger entirely. A batch stage reminder (#812) re-buzzes like a cook timer:
  // it is a timed call to act, hours from the last one, deduped server-side by a
  // real ledger rather than by the tag. Default true so the cook-timer path is
  // unchanged.
  var renotify = payload.renotify !== false;

  event.waitUntil(
    (async function () {
      // Foreground de-dup, FOR THE TWO KINDS THAT HAVE AN IN-APP ALERT: if a
      // window client is already focused, `cookTimerAlerts` chimes and the chip
      // (or, for a standalone timer, the card) flips to Finished, so the OS
      // notification would be a duplicate. That watcher is APP-level, not
      // page-level, and since #842 it watches the standalone timers too — which
      // is what makes the assumption true for 'kitchen-timer' as well.
      //
      // A shopping reminder has NO in-app equivalent, so suppressing it with the
      // app open would make it vanish silently — gate the suppression on the type,
      // not on focus alone. A 'batch-stage' reminder (#812) is omitted for exactly
      // that reason: nobody is staring at the batch page waiting for the retard to
      // end, so there is no in-app alert for the notification to duplicate, and
      // the app merely being open somewhere must not swallow it.
      if (type === 'cook-timer' || type === 'kitchen-timer') {
        var clientsArr = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        var hasFocused = clientsArr.some(function (c) {
          return c.focused || c.visibilityState === 'visible';
        });
        if (hasFocused) return;
      }

      await self.registration.showNotification(title, {
        body: body,
        tag: tag,
        renotify: renotify,
        // Non-silent → uses the OS notification sound (issue #544).
        silent: false,
        icon: '/icons/icon-192.png',
        // The badge is the small status-bar mark, and Android renders it from the
        // ALPHA CHANNEL ONLY — the opaque app icon came out as a solid grey blob, so
        // this is a transparent monochrome glyph (generate-icons.ts). It is shared by
        // every environment: this file is copied verbatim out of public/, so it gets
        // no %VITE_*% substitution, which is also why `icon` above stays the master
        // orange rather than the per-env variant.
        badge: '/icons/badge-96.png',
        data: { sessionId: sessionId, url: url },
      });
    })(),
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  var sessionId = data.sessionId || null;
  // Two routing sources, in precedence order:
  //   1. `data.url` — an explicit deep link the server chose. ALL FOUR kinds now
  //      send one: #629's shopping reminder opens the DEFAULT list, whose id only
  //      the server knows; #812's batch reminder opens `/#/batches/{batchId}`;
  //      #842's standalone kitchen timer opens `/#/mine`, which has no id in it at
  //      all; and since #1127 the cook timer sends `/#/recipes/{recipeId}/cook`,
  //      built by its sender from `session.recipeId` (onCookTimerDispatch.ts,
  //      `cookPath`). This is the primary route for every notification.
  //   2. `sessionId` — the cook-timer FALLBACK, and only that. It is still
  //      reached, which is why the slice below stays: Cloud Tasks queued before
  //      #1127 shipped carry the old payload with no `url`, and the cook-timer
  //      horizon runs to a cook session's lifetime. sessionId is
  //      `${recipeId}_${uid}`; recipe ids are UUIDs (hyphens, no underscore) and
  //      uids are alphanumeric, so the recipe id is everything before the final
  //      underscore. THIS SLICE IS A COOK-TIMER-ONLY LICENCE, granted by that
  //      collection's composite document id — never reconstruct a route from an id
  //      for any other kind. A batch id is an opaque UUID and its reminder carries
  //      a whole `url` for precisely this reason.
  // Hash-routed app, so both are '/#/…' paths. Falling back to '/' opens the app.
  var recipeId = sessionId ? sessionId.substring(0, sessionId.lastIndexOf('_')) : null;
  var url = data.url || (recipeId ? '/#/recipes/' + recipeId + '/cook' : null);

  event.waitUntil(
    (async function () {
      var clientsArr = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (var i = 0; i < clientsArr.length; i++) {
        var client = clientsArr[i];
        if ('focus' in client) {
          await client.focus();
          if (url && 'navigate' in client) {
            try {
              await client.navigate(url);
            } catch (_e) {
              /* navigate unsupported — focus is enough */
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url || '/');
    })(),
  );
});
