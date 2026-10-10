# Gapolania Racers — Spec de Web + Prompts de Imágenes para IA

> Documento único para armar la página web del juego en WordPress y generar las imágenes ilustrativas con IA. Reemplazar las imágenes IA por las reales (renders 3D) cuando estén listas.

---

## 📋 PARTE 1 — Análisis del juego

### Pitch
> **Gapolania Racers** es un juego de carreras multiplayer online para iOS y Android. Combina simulación de manejo realista con progresión competitiva: 6 circuitos, 5 clases de auto (D a S), sistema ranked tipo Elo, torneos cada 3 días con premios, clubes sociales, y temporadas de 90 días con Battle Pass.

### Público objetivo
- **Primario**: Jugadores mobile hardcore, 18-35 años, Latinoamérica + España, fans de Asphalt / CSR / Forza / Mario Kart Tour
- **Secundario**: Jugadores casuales que buscan partidas rápidas (5 min) con progresión a largo plazo
- **Edad**: +18 (rating por IAP y gambling-like loot boxes)
- **Plataformas**: iOS 14+ y Android 8+
- **Modelo de monetización**: Free-to-play con IAP (5 packs consumibles, 4 non-consumables, 1 suscripción) + rewarded ads (MOCK provider en dev)

### Tono y personalidad
| Aspecto | Valor |
|---|---|
| **Tono general** | Premium pero accesible. Velocidad pura + comunidad |
| **Voz** | Directo, en español latino neutro, sin jerga técnica |
| **Mood visual** | Cyberpunk-urbano + neón + atardeceres cinematográficos |
| **Emoción target** | Adrenalina +成就感 (logro) + FOMO competitivo |
| **Evitar** | Chibi, cartoon, pixel art, estilo infantil, lenguaje gamer tóxico |

### Competencia y diferenciadores
- **vs Asphalt 9**: Más competitivo (ranked real con ligas), más social (clubes con wars), menos pay-to-win
- **vs CSR Racing**: Más dinámico (carreras reales, no solo arrancones), ranked y torneos
- **vs Mario Kart Tour**: No cartoon, manejo más serio, esports real
- **vs Forza/Gran Turismo (mobile)**: Gratis, mobile-first, multiplayer constante

### Hooks únicos (lo que hace especial a Gapolania Racers)
1. **Server-authoritative** → no hay hackers, cada carrera es legítima
2. **92 leaderboards** → grind real, no artificial
3. **Ranked con 7 ligas + decay** → progreso medible, habilidad recompensada
4. **Torneos cada 3 días** → engagement constante, no solo "events" cada 2 meses
5. **Clubes con wars semanales** → vida social, retention
6. **6 circuitos con identidades visuales fuertes** → memorable, compartible
7. **Battle Pass sin pagar sigue siendo útil** → no pay-to-win, F2P viable

### Brand
- **Nombre**: Gapolania Racers (GR)
- **Tagline principal**: "Corre más rápido. Corre más alto."
- **Tagline alternativo**: "Hecho para los que buscan velocidad"
- **Hashtags**: #GapolaniaRacers #CorreRápido #Season1
- **Colores de marca**: Neón pink `#ff2d75`, eléctrico cyan `#00f0ff`, dorado `#ffd60a`, violeta `#7b2cbf`, verde menta `#06ffa5`
- **Logos**: Necesita logo principal (GR estilizado con speed lines), versión blanca, versión oscura, ícono cuadrado

---

## 🎨 PARTE 2 — Prompt detallado para la página web (WordPress)

> **Copiá todo este bloque y pegalo en tu AI builder de WordPress** (o pasáselo a quien te arme la página). Está redactado como un brief de diseño completo.

---

### PROMPT PRINCIPAL (copiar tal cual)

```
Armame una landing page de una sola página (single-page) en WordPress para un juego
móvil de carreras llamado "Gapolania Racers". Audiencia: jugadores mobile hardcore
hispanohablantes 18-35 años. Tono: premium, agresivo, velocidad, comunidad.

TEMA VISUAL:
- Dark mode permanente (no light mode toggle)
- Fondo principal: negro profundo #0a0e27
- Color de acento primario: rosa neón #ff2d75
- Color de acento secundario: cian eléctrico #00f0ff
- Color de destacado: dorado #ffd60a
- Tipografía display (títulos): Orbitron o Rajdhani
- Tipografía body (texto): Inter o similar sans-serif geométrica
- Iconos: estilo outline minimalista con acentos neón
- Efectos: glow, gradientes, líneas de velocidad, sutiles animaciones al scroll
- NO usar: emojis decorativos grandes, colores pastel, light mode, estilo infantil

ESTRUCTURA DE LA PÁGINA (en este orden, scroll vertical):

1. NAVBAR FIJA
   - Logo a la izquierda (Gapolania Racers)
   - Menú: Features | Circuitos | Autos | Modos | Torneos | Social
   - Botón "Descargar" a la derecha
   - Background con blur al hacer scroll
   - Mobile: hamburguesa que abre menú fullscreen

2. HERO (full viewport height)
   - Badge arriba: "🚀 TEMPORADA 1 EN VIVO" con pulse animation
   - Headline gigante: "CORRE MÁS RÁPIDO." en blanco
   - Headline segunda línea: "CORRE MÁS ALTO." con gradiente rosa-a-cian
   - Subtítulo: "Carreras multiplayer online con 6 circuitos, 5 clases de auto y
     ranked competitivo. Temporada 1 ya empezó. ¿Estás listo?"
   - Dos CTAs: "Descargar gratis" (primario, con gradient) + "Ver trailer" (ghost)
   - Debajo del subtítulo del botón primario: "iOS · Android" en texto pequeño
   - Stats row: 92 Leaderboards | 6 Circuitos | 5 Clases | 8 Jugadores
   - Background: imagen de auto en pista neón (oscurecida con overlay radial)
   - Scroll indicator al fondo con animación bounce

3. FEATURES (sección con 6 cards en grid 3x2 desktop, 1 columna mobile)
   - Tag: "POR QUÉ GAPOLANIA RACERS"
   - Título: "Hecho para los que buscan velocidad"
   - Subtítulo: "No es otro endless runner. Es un simulador de carreras
     competitivo donde cada decisión cuenta."
   - 6 cards con ícono emoji + título + descripción:
     a) 🏎️ Server-authoritative — El servidor valida cada carrera. No hay hacks.
     b) 🎯 Matchmaking por skill — Sistema Elo-like. Bronze hasta Champion.
     c) 🏆 Torneos con premios — Cada 3 días. Top-100 gana coins y cosméticos.
     d) 🎮 5 clases de auto — D, C, B, A, S. Cada una con física única.
     e) 🌍 Clubes sociales — Hasta 30 jugadores. Wars semanales.
     f) ⚡ Region relay — Servidores regionales con relay HMAC.

4. CIRCUITOS (grid 3x2 desktop, 2 columnas tablet, 1 mobile)
   - Tag: "6 CIRCUITOS ÚNICOS"
   - Título: "De neón urbano a cañones desérticos"
   - Subtítulo: "Cada circuito tiene su propia identidad."
   - 6 cards con imagen + nombre + ambiente:
     - Neon Blvd (Urbano · Nocturno)
     - Reef Run (Costero · Tropical)
     - Mountain Pass (Montaña · Otoño)
     - Canyon Drift (Desierto · Día)
     - Harbor Sprint (Puerto · Atardecer)
     - Factory Loop (Industrial · Indoor)
   - Hover: zoom en la imagen, borde cian

5. AUTOS (grid 5 columnas desktop, 2-3 tablet, 1 mobile)
   - Tag: "5 CLASES DE AUTO"
   - Título: "Del hatchback al hypercar"
   - Subtítulo: "Cada clase tiene su propia física. Empezá con D, terminá en S."
   - 5 cards con badge de clase, imagen del auto, specs:
     - Clase D (Hatchback) — 180 km/h · 7.2s 0-100 · 1.150 kg
     - Clase C (Coupé) — 230 km/h · 5.1s 0-100 · 1.320 kg
     - Clase B (GT) — 285 km/h · 3.8s 0-100 · 1.480 kg
     - Clase A (Superdeportivo) — 340 km/h · 2.9s 0-100 · 1.380 kg
     - Clase S (Hypercar) — 420 km/h · 2.2s 0-100 · 1.250 kg

6. MODOS DE JUEGO (grid 2x2 desktop)
   - Tag: "MODOS DE JUEGO"
   - Título: "4 modos para cada estilo"
   - 4 cards:
     - ⚡ Quick Race (Casual) — Carrera rápida, 8 jugadores, sin consecuencias
     - 🏆 Ranked (Competitivo · MÁS POPULAR badge) — Matchmaking por skill, ligas
     - ⏱️ Time Trial (Solitario) — 92 leaderboards te esperan
     - 👥 Private (Con amigos) — Hasta 8 jugadores, custom rules

7. RANKED (layout 2 columnas desktop, stacked mobile)
   - Tag: "PROGRESIÓN COMPETITIVA"
   - Título: "De Bronze a Champion"
   - Texto: "Cada victoria cuenta. Subí tu rating en 7 ligas."
   - Lista de ligas con íconos: 🥉 Bronze, ⚪ Silver, 🟡 Gold, 💎 Platinum,
     💠 Diamond, 👑 Master, 🌟 Champion
   - CTA: "Empezá tu climb"
   - Lado derecho: visual grande con el rating 2500+ Champion

8. TORNEOS Y EVENTOS (grid 2 columnas)
   - Tag: "COMPETICIONES"
   - Título: "Torneos cada 3 días · Eventos cada finde"
   - Card 1: Torneo Semanal con premios top-100
     - 🥇 1°: 50.000 coins + auto exclusivo + 500 Gems
     - 🥈 2-3°: 25.000 coins + cosmético + 200 Gems
     - 🎖️ 4-10°: 10.000 coins + 100 Gems
     - 🏅 11-100°: 2.000 coins + 50 Gems
   - Card 2: Special Event de finde
     - XP x2, Coins x3, special offers, cosmético exclusivo

9. ECONOMÍA (grid 4 columnas desktop)
   - Tag: "ECONOMÍA"
   - Título: "Ganá, gastá, progresá"
   - 4 cards de currency:
     - $ Coins (moneda blanda, se gana en todo, se gasta en autos D-C y cosméticos)
     - ◆ Gems (premium, IAP, se gasta en autos raros y BP premium)
     - XP Experience (por posición, bonus de misiones)
     - 🎟 Tournament Tokens (top-100, entry fee en torneos premium)

10. SOCIAL (grid 2x2)
    - Tag: "SOCIAL"
    - Título: "No corras solo"
    - 4 cards: Clubes, Amigos, Chat, Notificaciones push

11. BATTLE PASS (banner full-width con gradiente)
    - Tag: "BATTLE PASS"
    - Título: "30 niveles. 90 días."
    - Texto: "Subí tu pase gratis. Comprá premium para cosméticos exclusivos."
    - Visual: Free → arrow → Premium (con estilo diferente)

12. DOWNLOAD (sección centrada, fondo con glow rosa)
    - Título: "Empezá a correr hoy"
    - Subtítulo: "Gratis. Sin anuncios invasivos. Solo pagás si querés."
    - 2 botones grandes: "App Store" y "Google Play"
    - Nota pequeña: "+18 · IAP opcionales · Compatible iOS 14+ / Android 8+"

13. FOOTER (4 columnas desktop)
    - Col 1: Logo + tagline "Hecho con ❤️ en Argentina"
    - Col 2: Juego (Features, Circuitos, Autos, Modos)
    - Col 3: Competitivo (Ranked, Torneos, Battle Pass, Clubes)
    - Col 4: Legal (Términos, Privacidad, IAP, Soporte)
    - Bottom: copyright + versión (v1.0 · Build 2026.10.09)

COMPORTAMIENTO Y DETALLES:
- Smooth scroll entre secciones
- Animaciones fade-in al entrar en viewport
- Counter animation en los stats del hero (de 0 al número final)
- Hover effects en todas las cards (lift + border glow)
- Mobile: menú hamburguesa, grids colapsan a 1 columna
- CTAs primarios con gradient rosa-a-cian y glow
- Background de secciones alternadas (algunas con fondo #0a0e27, otras #050818)
- Imágenes con overlay oscuro para legibilidad del texto
- Botones "Descargar" que enlazan a /download (luego a App Store / Play Store)

SEO:
- Title: "Gapolania Racers — Carreras multiplayer online"
- Meta description: "Juego de carreras mobile con 6 circuitos, 5 clases de auto,
  ranked, torneos y clubes. Temporada 1 en vivo. Descargá gratis iOS y Android."
- Open Graph image: el hero_main
- Schema.org: VideoGame

PÁGINAS SECUNDARIAS (no en la landing, pero referenciadas en el footer):
- /terminos — Términos de servicio
- /privacidad — Política de privacidad
- /iap — Política de IAP y refunds
- /soporte — Formulario de contacto
- /clubes — Landing secundaria de clubs (futuro)
- /temporada-1 — Detalle de la temporada actual (futuro)

PLUGINS WORDPRESS SUGERIDOS:
- Elementor Pro o Bricks Builder (para armar el layout)
- Smush (optimización de imágenes)
- WP Rocket (cache)
- Rank Math SEO
- WooCommerce (si querés vender merch o códigos de Gems en la web)
- Polylang (si vas a traducir a inglés/portugués)

HOSTING RECOMENDADO:
- Cloudways / Kinsta (managed WordPress)
- O Cloudflare Pages + headless WP si querés ultra-rápido
```

---

## 🖼 PARTE 3 — Prompts de imágenes para IA

> **Por cada imagen**: nombre de archivo, dónde se usa, dimensiones, prompt detallado para Midjourney / DALL-E / Stable Diffusion XL.

> **Workflow**: Generar todas → revisar → re-generar las que no cumplan → reemplazar los placeholders.

### LINEAMIENTOS GENERALES (aplican a todas las imágenes)

```
Mood: cyberpunk-urbano + velocidad + neón
Estilo: realismo estilizado (NO cartoon, NO chibi, NO pixel art, NO anime)
Paleta dominante: negro profundo, rosa neón #ff2d75, cian #00f0ff
Lighting: cinematic, con lens flare y motion blur sutil
Aspect ratio: 16:9 para hero, 1:1 para iconos, 2:3 para posters
Modelo recomendado: Midjourney v6 / DALL-E 3 / SDXL con refiner
Resolución mínima: 1920x1080 hero, 1024x576 cards, 512x512 iconos
```

---

### CRÍTICAS (para que la página funcione)

#### IMG-01 · Hero principal
- **Archivo final**: `assets/hero_main.png`
- **Uso**: Background de la sección hero (full viewport)
- **Dimensiones**: 1920x1080 (16:9)
- **Prompt**:
```
A high-speed racing car drifting through a cyberpunk neon city at night,
motion blur on the wheels, glowing underbody neon lights in pink #ff2d75
and cyan #00f0ff, rain-slicked asphalt reflecting city lights, lens flare
from headlights, cinematic 16:9 composition, low camera angle, photorealistic
with stylized saturation, dark mood with bright neon highlights, 4K detail
```

#### IMG-02 · Hero mobile
- **Archivo final**: `assets/hero_mobile.png`
- **Uso**: App store screenshot, banner vertical
- **Dimensiones**: 1080x1920 (9:16)
- **Prompt**:
```
Top-down view of a futuristic racing car on a neon-lit track, glowing trail
behind the car in pink #ff2d75 and cyan #00f0ff, grid pattern on the asphalt,
3 other cars visible in the distance, vertical 9:16 composition, high
contrast, dark background with vibrant neon elements
```

#### IMG-03 a IMG-08 · Los 6 circuitos

**IMG-03 · Neon Blvd (urbano nocturno)**
- **Archivo**: `assets/circuits/neon_blvd.png` · 1920x1080
- **Uso**: Card de circuito
- **Prompt**:
```
Wide shot of a Tokyo-Shibuya style city street circuit at night, giant LED
billboards in Japanese characters and English, pink #ff2d75 and cyan #00f0ff
neon signs everywhere, wet reflective asphalt, a single racing car in the
foreground with motion blur, 3D perspective looking down the boulevard,
dramatic depth of field, photorealistic
```

**IMG-04 · Reef Run (costero tropical)**
- **Archivo**: `assets/circuits/reef_run.png` · 1920x1080
- **Prompt**:
```
A coastal racing track built over a tropical reef, turquoise water on both
sides, a racing car jumping over a small bridge, palm trees and rocky cliffs
in the background, golden hour lighting, dramatic ocean waves, photorealistic
```

**IMG-05 · Mountain Pass (montaña otoño)**
- **Archivo**: `assets/circuits/mountain_pass.png` · 1920x1080
- **Prompt**:
```
A mountain racing track on a cliffside road, hairpin turn visible in the
distance, snow-capped peaks in the background, autumn trees with red and
orange leaves, a sports car drifting through the turn, golden sunset light,
cinematic wide shot
```

**IMG-06 · Canyon Drift (desierto)**
- **Archivo**: `assets/circuits/canyon_drift.png` · 1920x1080
- **Prompt**:
```
A red rock canyon racing track similar to US Southwest, a sports car doing
a high-speed drift creating a dust cloud, dramatic red sandstone formations,
deep blue sky, harsh midday sun, action photography style
```

**IMG-07 · Harbor Sprint (puerto)**
- **Archivo**: `assets/circuits/harbor_sprint.png` · 1920x1080
- **Prompt**:
```
A racing track through a busy container port at dusk, stacked shipping
containers as barriers, cranes and cargo ships in the background, sodium
vapor lights creating warm pools of light, a racing car weaving through
containers, cinematic composition
```

**IMG-08 · Factory Loop (industrial indoor)**
- **Archivo**: `assets/circuits/factory_loop.png` · 1920x1080
- **Prompt**:
```
An indoor industrial racing circuit inside an abandoned factory, exposed
steel beams and pipes, sparks from welding, dramatic volumetric lighting
through broken skylights, a car racing through the concrete floor track,
dystopian cyberpunk aesthetic
```

#### IMG-09 a IMG-13 · Las 5 clases de auto

**IMG-09 · Clase D (hatchback básico)**
- **Archivo**: `assets/cars/class_d.png` · 1024x576 (16:9)
- **Prompt**:
```
A compact hatchback racing car, vibrant yellow paint with black racing
stripes, sporty but affordable aesthetic, studio shot on dark background,
3/4 front view, detailed wheels and aerodynamic details, photorealistic
```

**IMG-10 · Clase C (coupé sport)**
- **Archivo**: `assets/cars/class_c.png` · 1024x576
- **Prompt**:
```
A sporty coupe racing car, metallic red paint, dual exhaust, low profile,
19-inch alloy wheels, aggressive front splitter, studio shot on dark
background, 3/4 front view, photorealistic
```

**IMG-11 · Clase B (gran turismo)**
- **Archivo**: `assets/cars/class_b.png` · 1024x576
- **Prompt**:
```
A grand tourer racing car, dark gunmetal grey paint, large rear wing, wide
fenders, LED headlights, 20-inch black wheels, carbon fiber accents, studio
shot on dark background, photorealistic
```

**IMG-12 · Clase A (superdeportivo)**
- **Archivo**: `assets/cars/class_a.png` · 1024x576
- **Prompt**:
```
A supercar, vibrant orange paint, active aerodynamic elements, massive rear
wing, side air intakes, glowing brake calipers, studio shot with subtle
floor reflection on dark background, 3/4 view
```

**IMG-13 · Clase S (hypercar)**
- **Archivo**: `assets/cars/class_s.png` · 1024x576
- **Prompt**:
```
A futuristic hypercar, chrome and iridescent paint, holographic accents, no
visible headlights (just LED strips), extreme aerodynamic shape, jet-fighter
inspired, dramatic studio lighting, dark background, photorealistic
```

#### IMG-14 a IMG-17 · Logos (4 variantes)

**IMG-14 · Logo principal (horizontal)**
- **Archivo**: `assets/logos/logo_main.png` · 2048x512 (4:1)
- **Uso**: Header de la web, email signatures
- **Prompt**:
```
A modern horizontal logo for "Gapolania Racers", geometric typography with
neon pink #ff2d75 to cyan #00f0ff gradient, a stylized "GR" monogram with
speed lines extending to the right, futuristic racing aesthetic, transparent
background, vector style
```

**IMG-15 · Logo blanco (para fondos oscuros)**
- **Archivo**: `assets/logos/logo_white.png` · 2048x512
- **Prompt**:
```
The same Gapolania Racers logo but in pure white, no gradient, suitable for
dark backgrounds, transparent background, vector style
```

**IMG-16 · Logo oscuro (para fondos claros)**
- **Archivo**: `assets/logos/logo_dark.png` · 2048x512
- **Prompt**:
```
The Gapolania Racers logo in deep navy blue #0a0e27, suitable for light
backgrounds, transparent background, vector style
```

**IMG-17 · Logo ícono (cuadrado, app icon)**
- **Archivo**: `assets/logos/logo_icon.png` · 1024x1024 (1:1)
- **Uso**: Favicon, app icon, Open Graph
- **Prompt**:
```
A square app icon featuring the stylized "GR" monogram from Gapolania
Racers, with a circular speed-line motif around it, neon pink to cyan
gradient, dark background filling the square with rounded corners, modern
minimalist, suitable for mobile app icon
```

---

### IMPORTANTES (para que la página se vea completa)

#### IMG-18 a IMG-22 · Los 5 pilotos

**IMG-18 · Piloto 1 (mujer, rosa)**
- **Archivo**: `assets/characters/pilot_01.png` · 512x512
- **Prompt**:
```
Portrait of a female racing driver, wearing a futuristic racing helmet with
tinted pink visor, white racing suit with pink neon accents, cinematic
studio lighting, dark gradient background, head and shoulders only,
photorealistic
```

**IMG-19 · Piloto 2 (hombre, cian)**
- **Archivo**: `assets/characters/pilot_02.png` · 512x512
- **Prompt**:
```
Portrait of a male racing driver, futuristic racing helmet with cyan tinted
visor, black racing suit with cyan neon accents, cinematic studio lighting,
dark gradient background, head and shoulders only, photorealistic
```

**IMG-20 · Piloto 3 (mujer, dorado)**
- **Archivo**: `assets/characters/pilot_03.png` · 512x512
- **Prompt**:
```
Portrait of a female racing driver, gold tinted helmet visor, red racing
suit with gold neon accents, cinematic studio lighting, dark gradient
background, head and shoulders only, photorealistic
```

**IMG-21 · Piloto 4 (hombre, verde)**
- **Archivo**: `assets/characters/pilot_04.png` · 512x512
- **Prompt**:
```
Portrait of a male racing driver, green tinted helmet visor, grey racing
suit with green neon accents, cinematic studio lighting, dark gradient
background, head and shoulders only, photorealistic
```

**IMG-22 · Piloto 5 (no-binario, violeta)**
- **Archivo**: `assets/characters/pilot_05.png` · 512x512
- **Prompt**:
```
Portrait of a non-binary racing driver, purple tinted helmet visor, white
racing suit with purple neon accents, cinematic studio lighting, dark
gradient background, head and shoulders only, photorealistic
```

#### IMG-23 a IMG-25 · Trophies de torneos

**IMG-23 · Trofeo Oro (1° lugar)**
- **Archivo**: `assets/tournaments/trophy_gold.png` · 800x800 (1:1)
- **Prompt**:
```
A giant gold cup trophy with neon pink #ff2d75 and cyan #00f0ff accent
lights, laser lights, podium background with confetti, dramatic lighting,
dark background, photorealistic
```

**IMG-24 · Trofeo Plata (2-3° lugar)**
- **Archivo**: `assets/tournaments/trophy_silver.png` · 800x800
- **Prompt**:
```
A silver cup trophy, smaller than the gold one, polished metal with neon
cyan #00f0ff accent lights, dramatic lighting, dark background,
photorealistic
```

**IMG-25 · Banner de Torneo**
- **Archivo**: `assets/tournaments/banner.png` · 1920x600 (3.2:1)
- **Prompt**:
```
A racing tournament banner with "WEEKLY CHAMPIONSHIP" placeholder text,
dramatic arena in the background, neon lights in pink and cyan, confetti,
large horizontal composition, dark background
```

#### IMG-26 a IMG-29 · Eventos especiales

**IMG-26 · Evento Drift**
- **Archivo**: `assets/events/event_drift.png` · 1024x576
- **Prompt**:
```
A car doing a long drift with thick white smoke trail, racing circuit
background with neon lights, dynamic action shot, dark background,
photorealistic
```

**IMG-27 · Evento Sprint**
- **Archivo**: `assets/events/event_sprint.png` · 1024x576
- **Prompt**:
```
A car at extreme high speed on a straight track, motion blur on the
background, neon light streaks, dark background, photorealistic action shot
```

**IMG-28 · Evento Eliminación**
- **Archivo**: `assets/events/event_elimination.png` · 1024x576
- **Prompt**:
```
Multiple racing cars on a track, one car crashing in the background with
sparks, dramatic lighting, dark background, photorealistic
```

**IMG-29 · Evento Lluvia**
- **Archivo**: `assets/events/event_rain.png` · 1024x576
- **Prompt**:
```
A car on a wet track with heavy rain drops, reflections on the asphalt,
dramatic lighting, dark moody background, photorealistic
```

#### IMG-30 a IMG-32 · Battle Pass

**IMG-30 · BP Free reward**
- **Archivo**: `assets/pass/bp_free.png` · 800x800
- **Prompt**:
```
A silver trophy with a star, glowing softly, "FREE" placeholder label,
game UI asset style, dark background, 1:1 ratio, simple but detailed
```

**IMG-31 · BP Premium reward**
- **Archivo**: `assets/pass/bp_premium.png` · 800x800
- **Prompt**:
```
A golden trophy with a diamond on top, glowing intensely, "PREMIUM"
placeholder label, gold and purple particles, game UI asset style, dark
background, 1:1 ratio
```

**IMG-32 · BP Season banner**
- **Archivo**: `assets/pass/season_banner.png` · 1920x400
- **Prompt**:
```
A racing themed banner with 3 cars in formation driving, giant number "01"
in the background, neon pink #ff2d75 and cyan #00f0ff accents, dark
background, large horizontal composition
```

#### IMG-33 a IMG-35 · Currency icons (4)

**IMG-33 · Coin icon**
- **Archivo**: `assets/ui/coin.png` · 256x256
- **Prompt**:
```
A shiny gold coin with "$" symbol engraved, game UI icon, dark transparent
background, 1:1 ratio, simple but detailed, photorealistic
```

**IMG-34 · Gem icon**
- **Archivo**: `assets/ui/gem.png` · 256x256
- **Prompt**:
```
A faceted cyan #00f0ff gem with pink #ff2d75 highlights, game UI icon, dark
transparent background, 1:1 ratio, simple but detailed, photorealistic
```

**IMG-35 · XP icon**
- **Archivo**: `assets/ui/xp.png` · 256x256
- **Prompt**:
```
A glowing green #06ffa5 star icon, game UI asset, dark transparent
background, 1:1 ratio, simple but detailed
```

---

### NICE TO HAVE (pulido visual)

#### IMG-36 a IMG-40 · Variantes de color de autos (5 principales)

**IMG-36 · Clase D variante roja**
- **Archivo**: `assets/cars/variants/d_red.png` · 1024x576
- **Prompt**:
```
The same compact hatchback from the class D car but in vibrant red paint
with black racing stripes, studio shot, dark background, 3/4 view
```

**IMG-37 · Clase C variante azul**
- **Archivo**: `assets/cars/variants/c_blue.png` · 1024x576
- **Prompt**:
```
The same sporty coupe from class C but in metallic electric blue paint,
studio shot, dark background, 3/4 view
```

**IMG-38 · Clase B variante blanca**
- **Archivo**: `assets/cars/variants/b_white.png` · 1024x576
- **Prompt**:
```
The same grand tourer from class B but in pearl white paint with carbon
fiber accents, studio shot, dark background, 3/4 view
```

**IMG-39 · Clase A variante negra**
- **Archivo**: `assets/cars/variants/a_black.png` · 1024x576
- **Prompt**:
```
The same supercar from class A but in matte black paint with subtle neon
underglow, studio shot, dark background, 3/4 view
```

**IMG-40 · Clase S variante dorada**
- **Archivo**: `assets/cars/variants/s_gold.png` · 1024x576
- **Prompt**:
```
The same hypercar from class S but in 24k gold chrome paint with
holographic iridescence, studio shot, dark background, 3/4 view
```

#### IMG-41 a IMG-43 · Social/Clubes

**IMG-41 · Banner de Club**
- **Archivo**: `assets/social/club_banner.png` · 1200x300
- **Prompt**:
```
A racing team garage scene with multiple cars parked in a row, banners
hanging from the ceiling, dark industrial setting with neon accents,
horizontal composition
```

**IMG-42 · Emblema genérico de club**
- **Archivo**: `assets/social/club_emblem.png` · 512x512
- **Prompt**:
```
A flaming skull wearing a racing helmet, game UI emblem style, dark
background, neon fire accents, 1:1 ratio, suitable for profile picture
```

**IMG-43 · Icono de chat**
- **Archivo**: `assets/social/chat_icon.png` · 256x256
- **Prompt**:
```
A speech bubble with neon cyan #00f0ff outline, simple icon design, game
UI style, dark transparent background, 1:1 ratio
```

#### IMG-44 a IMG-47 · Backgrounds secundarios

**IMG-44 · Background Features**
- **Archivo**: `assets/backgrounds/bg_features.png` · 1920x600
- **Prompt**:
```
A wide horizontal racing scene with empty space in the center for text
overlay, dark background, dramatic lighting, abstract speed lines
```

**IMG-45 · Background Competitive**
- **Archivo**: `assets/backgrounds/bg_competitive.png` · 1920x600
- **Prompt**:
```
A podium scene background with confetti and neon lights, wide horizontal
composition, dark background, space for text overlay
```

**IMG-46 · Background Social**
- **Archivo**: `assets/backgrounds/bg_social.png` · 1920x600
- **Prompt**:
```
A racing team group photo composition background, multiple cars in
formation, wide horizontal, dark background, space for text overlay
```

**IMG-47 · Background Download**
- **Archivo**: `assets/backgrounds/bg_download.png` · 1920x600
- **Prompt**:
```
A bright neon download-themed background with arrows pointing down and
circuit lines, wide horizontal composition, dark background with bright
neon highlights
```

---

## 📊 Resumen de producción

| Prioridad | Cantidad | Tiempo estimado |
|---|---|---|
| 🔴 **Crítico** | 17 imágenes | 3-4 horas |
| 🟡 **Importante** | 18 imágenes | 3-4 horas |
| 🟢 **Nice-to-have** | 12 imágenes | 2-3 horas |
| **TOTAL** | **47 imágenes** | **8-11 horas** |

---

## 🛠 Workflow recomendado

### Paso 1: Generar en orden de prioridad
1. Empezar por las 17 críticas (sin estas la página no se ve completa)
2. Probar primero con 1-2 imágenes de cada categoría para validar el estilo
3. Iterar el prompt si los resultados no son consistentes

### Paso 2: Optimizar
- Comprimir PNGs con `pngquant --quality=70-90 image.png`
- Convertir a WebP con `cwebp -q 80 image.png -o image.webp`
- Generar versiones mobile a la mitad del tamaño

### Paso 3: Metadata
Para cada imagen, crear un `.json` adyacente con:
```json
{
  "prompt": "el prompt completo que usaste",
  "model": "midjourney-v6",
  "seed": 12345,
  "negative_prompt": "cartoon, anime, blurry, low quality",
  "aspect_ratio": "16:9",
  "version": "v1",
  "date": "2026-10-09",
  "replace_with": "render 3D cuando esté listo"
}
```

### Paso 4: Subir a WordPress
- Las imágenes IA suben a `wp-content/uploads/illustrations/`
- Las imágenes reales (renders 3D) van a `wp-content/uploads/real/`
- En la página usar las IA primero, swap a las reales cuando estén

### Paso 5: Cuando lleguen los renders 3D reales
- Comparar side-by-side con la IA
- Si el render es mejor, reemplazar manteniendo mismo aspect ratio
- Si el render tiene diferente ángulo, ajustar el layout de la página
- Mantener el `.json` actualizado con la versión real

---

## 🎯 Notas de uso

- **Las imágenes IA son ilustrativas**: se usan para tener la página online YA, mientras se renderizan las reales en 3D (Blender + Substance)
- **El estilo debe ser coherente**: usar siempre la misma paleta de colores en los prompts (`#ff2d75`, `#00f0ff`, `#ffd60a`)
- **El aspect ratio importa**: si el layout es 16:9, generá la imagen en 16:9 desde el inicio
- **Prompt negative universal** (agregar a todos): `cartoon, anime, chibi, blurry, low quality, deformed, text, watermark, signature`
- **El prompt de la página web está en español**: si tu AI builder de WordPress funciona mejor en inglés, traducilo pero mantené la estructura y secciones

---

## 📞 Contacto

Cualquier duda sobre este spec → dev@gapolaniadev.com
