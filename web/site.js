// Copy-to-clipboard on any [data-copy] control.
for (const el of document.querySelectorAll("[data-copy]")) {
  el.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(el.getAttribute("data-copy"));
      el.classList.add("copied");
      const prev = el.innerHTML;
      if (el.classList.contains("btn")) el.textContent = "Copied — now run `oce`";
      setTimeout(() => { el.classList.remove("copied"); if (el.classList.contains("btn")) el.innerHTML = prev; }, 1600);
    } catch {}
  });
}

// Reveal on scroll — progressive enhancement. The hidden state only exists
// under html.js-reveal, so content is never invisible without JS.
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!reduced && "IntersectionObserver" in window) {
  document.documentElement.classList.add("js-reveal");
  const io = new IntersectionObserver((entries) => {
    let i = 0;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target;
      setTimeout(() => el.classList.add("in"), i++ * 60);
      io.unobserve(el);
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
  for (const el of document.querySelectorAll(".reveal")) io.observe(el);
}
