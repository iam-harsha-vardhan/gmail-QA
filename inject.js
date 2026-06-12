(() => {

  try {

    let ik = null;

    // =================================================
    // GLOBALS
    // =================================================

    try {

      if (
        typeof GLOBALS !== 'undefined' &&
        GLOBALS[9]
      ) {

        ik = GLOBALS[9];
      }

    } catch {}

    // =================================================
    // HTML FALLBACK
    // =================================================

    if (!ik) {

      const html =
        document.documentElement
          .innerHTML;

      const patterns = [

        /"ik":"([^"]+)"/,

        /,ik,["']([^"']+)["']/,

        /"([^"]+)","ik"/
      ];

      for (const pattern of patterns) {

        const match =
          html.match(pattern);

        if (
          match &&
          match[1]
        ) {

          ik = match[1];

          break;
        }
      }
    }

    window.postMessage({

      type: 'GAUTH_IK',

      ik

    }, '*');

  } catch (e) {

    console.error(
      '[GAuth Inject]',
      e
    );
  }

})();