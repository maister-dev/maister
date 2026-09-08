(() => {
  if (document.getElementById("maister-docs-metrika")) return;

  (function(m,e,t,r,i,k,a){
    m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
    m[i].l=1*new Date();
    for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
    k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,k.id="maister-docs-metrika",a.parentNode.insertBefore(k,a)
  })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js?id=112387867', 'ym');

  ym(112387867, 'init', {ssr:true, webvisor:true, clickmap:true, referrer: document.referrer, url: location.href, accurateTrackBounce:true, trackLinks:true});

  let previousUrl = window.location.href.split("#")[0];

  function trackPageView() {
    const url = window.location.href.split("#")[0];
    if (url === previousUrl) return;

    ym(112387867, "hit", url, {
      referer: previousUrl,
      title: document.title,
    });
    previousUrl = url;
  }

  // Mintlify changes articles without reloading custom scripts; hash links stay on the same page.
  const observer = new MutationObserver(trackPageView);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", () => requestAnimationFrame(trackPageView));
})();
