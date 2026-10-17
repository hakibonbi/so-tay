const V="tl-28f096046b",SHELL=["./","index.html","manifest.webmanifest","icon-192.png","icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(V).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V&&x!=="tl-media").map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener("message",e=>{if(e.data==="SKIP")self.skipWaiting()});
self.addEventListener("fetch",e=>{const r=e.request;if(r.method!=="GET")return;const u=new URL(r.url);if(u.origin!==location.origin)return;
 if(u.pathname.startsWith("/api/media/")){e.respondWith(caches.open("tl-media").then(c=>c.match(r).then(h=>h||fetch(r).then(x=>{if(x.ok)c.put(r,x.clone());return x}))));return}
 if(u.pathname.startsWith("/api/")){e.respondWith(fetch(r).catch(()=>new Response('{"offline":true}',{status:503,headers:{"content-type":"application/json"}})));return}
 if(r.mode==="navigate"){e.respondWith(fetch(r).then(x=>{if(x.ok){const y=x.clone();caches.open(V).then(c=>c.put("index.html",y))}return x}).catch(()=>caches.match("index.html").then(h=>h||caches.match("./"))));return}
 e.respondWith(caches.match(r).then(h=>h||fetch(r).then(x=>{if(x.ok){const y=x.clone();caches.open(V).then(c=>c.put(r,y))}return x})))});
