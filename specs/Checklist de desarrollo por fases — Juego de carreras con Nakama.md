| Checklist de desarrollo por fases — Juego de carreras con Nakama Oct 5, 2026 · @Jairo Nueve fases, cada una con sus tareas de servidor, de cliente Unity y de pruebas como casillas para marcar. Una fase termina cuando todas las casillas de su criterio de terminado están marcadas. El diseño y el porqué de cada sistema están en Doc . Tablero |  |  |  |
| --- | --- | --- | --- |
| Fase | Estado | Depende de | Qué deja funcionando |
| 1. Sesión de carrera y resultados | 🟡 Servidor con casillas abiertas (triage F8, 2026-10-23) | Lo ya hecho | Un resultado oficial por carrera, validado por el servidor |
| 2. Leaderboards y perfil | 🟡 Servidor con casillas abiertas (triage F8, 2026-10-23) | Fase 1 | Tablas reconstruidas que solo escribe el servidor |
| 3. Economía, garaje y progresión | 🟡 Servidor con casillas abiertas (triage F8, 2026-10-23) | Fase 1 | Ganar monedas, comprar y mejorar autos, subir de nivel |
| 4. Matchmaking y ranked | 🟡 Servidor con casillas abiertas (triage F8, 2026-10-23) | Fases 1 y 3 | Colas de 2, 4 y 6 autos, bots, rating y reconexión |
| 5. Operación y lanzamiento en pruebas | 🟡 Servidor con casillas abiertas (triage F8, 2026-10-23) | Fases 1 a 4 | Servidor de producción, cuentas enlazadas, juego publicable |
| 6. Misiones, logros y pase | 🟡 Servidor con casillas abiertas (triage F8, 2026-10-23) | Fases 3 y 5 | Misiones diarias, pase de temporada, cierre de temporada |
| 7. Social | 🟡 Servidor con casillas abiertas (triage F8, 2026-10-23) | Fase 5 | Amigos, grupos, clubes y chat moderado |
| 8. Torneos y eventos | 🟡 Servidor con casillas abiertas (triage F8, 2026-10-23) | Fases 2, 4 y 5 | Torneos con premio, calendario de eventos, telemetría |
| 9. Compras reales y anuncios | 🟡 Servidor con casillas abiertas (triage F8, 2026-10-23) | Fases 3 y 5 | Venta de gemas, paquetes y pase en móvil y PC |



**Triage F8 (2026-10-23).** Las casillas que la auditoría del 2026-10-18 dio por parciales, ausentes o no verificables se revisaron contra la rama `fix/audit-preconditions` (plan de arreglos F0–F8). Cada una lleva su estado y su evidencia en cursiva: *hecha* (con el commit), *abierta* (tarjeta de la fase F9 propuesta), *decisión del usuario*, *descarte propuesto*, *fuera de alcance*, *pendiente del usuario* (credenciales, dispositivos o infraestructura) o *criterio del cliente*. Solo quedan marcadas las casillas con evidencia. Lista completa: `specs/Triage F8 de la auditoría (2026-10-23).csv`.

---


En cada fase las casillas van en cuatro grupos: Servidor (una persona), Cliente Unity (una
persona), Pruebas y Criterio de terminado. Servidor y cliente pueden avanzar en paralelo
si acuerdan primero el contrato de cada RPC, que es siempre la primera casilla.
## Fase 1 — Sesión de carrera y resultados
Objetivo: que cada carrera produzca un único resultado oficial en el servidor y un evento
RaceCompleted. Todo el metajuego posterior se conecta a ese evento.
### 1.1 Preparación del proyecto de servidor
- [x] Repositorio del servidor con proyecto TypeScript: tsconfig, tipos del runtime de Nakama y empaquetado a un solo index.js
- [x] Docker Compose local con Nakama y PostgreSQL, y el módulo compilado montado en el contenedor — *F8 (2026-10-23) · hecha: stack local en Docker con el override 127.0.0.1 verificada en vivo (T-05 e0afd27)*
- [x] Estructura de carpetas: un directorio por módulo y un main.ts con InitModule que registra todo
- [x] README con la convención de nombres de RPC, el formato de respuesta {ok, data, error} y la lista de códigos de error — *F8 (2026-10-23) · hecha: README: convención de nombres de RPC, envelope y enlace a los 14 códigos (T-27 e2ce6f5 + T-28)*
- [x] Linter y pruebas unitarias de lógica pura (sin Nakama) en un solo comando — *F8 (2026-10-23) · hecha: `npm run verify` = lint, build y tests; pasa en un clon limpio (T-26 75cbd1d)*
- [ ] Documento con los códigos de operación del protocolo de carrera actual — *F8 (2026-10-23) · abierta: F9 T-41: documentar los op codes del relay tal como los usa el cliente (el servidor no interpreta tramas)*
### 1.2 Contratos
- [x] Contrato escrito (entrada, salida, errores) de config_get, race_session_create, race_session_join, race_session_start, race_session_get y race_submit_result — *F8 (2026-10-23) · hecha: unity-api.md §6 al día (sin id → sesión activa) y OpenAPI con test de contrato (T-08 48e516f, T-27 e2ce6f5)*
- [x] Forma del evento RaceCompleted acordada: sesión, modo, pista, tamaño, lista ordenada de participantes con tiempos, confianza y marcas — *F8 (2026-10-23) · hecha: el evento lleva `confidence` y `flags.botSession` (T-09 27c086c); es interno del servidor (T-27); las marcas anti-trampas las calcula su suscriptor (T-23)*
### 1.3 Servidor: módulo core
- [x] Carga de catálogos JSON al arrancar, con validación de esquema; un catálogo inválido impide el arranque
- [x] Catálogo tracks: id, vueltas por modo, número de checkpoints y tiempo mínimo plausible por clase de auto
- [x] Catálogo modes: rápida, ranked, privada y contrarreloj, con tamaños permitidos (2, 4,
- [x] Catálogo modes: rápida, ranked, privada y contrarreloj, con tamaños permitidos (2, 4, 6) y multiplicadores
- [x] config_get: catálogos públicos, hash, hora del servidor, versión mínima de cliente — *F8 (2026-10-23) · hecha: `minClientVersion` de LiveOps por plataforma y puerta `UPGRADE_REQUIRED` (T-14 36ca406)*


---


- [x] Utilidad de idempotencia: clave registrada devuelve el resultado guardado en la segunda llamada
- [ ] Utilidad de errores tipados y de log que incluye siempre el ID de sesión de carrera — *F8 (2026-10-23) · abierta: F9 T-30: el helper `withSession` de core/logger.ts sigue sin usarse*
- [x] Utilidad de límite de frecuencia por jugador y por RPC
- [x] Bus interno de eventos: los módulos se suscriben a RaceCompleted en InitModule; si un suscriptor falla, se registra y los demás continúan
- [x] Campo schemaVersion y función de migración al leer en el ayudante de storage
### 1.4 Servidor: módulo race
- [x] Modelo RaceSession: id, ID de match, modo, pista, tamaño, roster (jugador, loadout, es bot), host, sucesión de host, estado, startedAt, resultados
- [ ] Estados de sesión: created, started, closing, closed, con transiciones válidas comprobadas race_session_create para salas privadas: el host envía el ID del match creado desde el cliente, modo, pista y tamaño race_session_join: cada jugador de la sala confirma su entrada; el servidor lo añade al roster mientras haya cupo — *F8 (2026-10-23) · abierta: F9 T-30: `closing` nunca se persiste y el cierre no comprueba la transición*
- [x] Índice de sesión activa por jugador, para saber si tiene una carrera viva — *F8 (2026-10-23) · hecha: índice `race_active/<userId>` (T-08 48e516f; humo d13bdb2)*
- [x] race_session_start: solo el host; sella startedAt con el reloj del servidor y devuelve la hora de salida
- [x] race_session_get: devuelve la sesión viva del jugador o la última cerrada — *F8 (2026-10-23) · hecha: sin id devuelve la sesión activa o la última cerrada (T-08 48e516f; humo d13bdb2)*
- [x] race_submit_result: validación de roster, estado de sesión y reporte no duplicado
- [x] Validación de reloj: el tiempo reportado no supera el transcurrido desde startedAt
- [x] Validación de tiempo mínimo plausible de la pista para la clase del auto
- [x] Validación de vueltas: cantidad correcta y suma igual al total Reporte de bots aceptado solo desde el host
- [x] Cierre de sesión: cuando todos reportaron o 30 s después del primer reporte; se evalúa en cada llamada a la sesión Quien no reportó al cierre queda como abandono — *F8 (2026-10-23) · 1.4.13 hecha: cierre a `CLOSE_GRACE_MS` del primer informe, perezoso y por el ticker (T-06 2528ae5; humo d13bdb2); 1.4.14 hecha: ausentes `DNF` al cierre por gracia (T-06 2528ae5; humo d13bdb2)*
- [x] Cálculo del orden oficial por tiempo total, con abandonos al final
- [ ] Quórum: comparar el orden visto por cada cliente y asignar confianza quorum o client Registro de marcas de revisión con el motivo — *F8 (2026-10-23) · 1.4.16 descarte propuesto: el informe no lleva el orden visto por cada cliente; T-09 redefinió el quórum como ⌈n/2⌉ informes humanos (27c086c); 1.4.17 hecha: `needsReview`/`incomplete_reports` alcanzable con el cierre por gracia (T-06 2528ae5, T-09 27c086c)*
- [x] Emisión de RaceCompleted exactamente una vez por sesión, protegida con escritura condicional por versión


---


- [ ] Respuesta de race_submit_result y de race_session_get con el resultado oficial cuando la sesión está cerrada — *F8 (2026-10-23) · abierta: F9 T-30: un cierre perezoso no devuelve recompensas ni confianza a nadie (pendiente F1-2)*
### 1.5 Cliente Unity
- [ ] Interfaces IConfigService, IRaceSessionService e IServerClock con implementación Nakama, registradas en el contenedor
- [ ] Reloj de servidor: diferencia calculada con varias muestras y mediana Descarga de catálogos y caché local por hash
- [ ] Sala privada: tras crear el match, el host llama race_session_create y los demás race_session_join
- [ ] Pista, vueltas y loadouts de todos los autos aplicados desde la sesión
- [ ] Cuenta regresiva basada en la hora de salida del servidor
- [ ] Mensajes de checkpoint y de meta con código de operación propio, separados del estado del auto
- [ ] Registro local de tiempo por vuelta y parcial por checkpoint
- [ ] Envío del resultado al cruzar la meta, con reintentos y cola si no hay red El host reporta los resultados de los bots
- [ ] Pantalla de resultados pintada con la respuesta del servidor; consulta la sesión cada 2 s hasta el cierre
- [ ] Mensajes para resultado rechazado y sesión no encontrada
### 1.6 Pruebas
- [ ] Pruebas unitarias de orden oficial, quórum y cada validación Carrera completa con 2, 4 y 6 clientes reales — *F8 (2026-10-23) · pendiente del usuario: necesita clientes, redes o dispositivos reales (BackendSmoke y pruebas del usuario); el servidor ya cierra carreras de 3 cuentas en el humo*
- [x] Reenviar el mismo resultado devuelve la misma respuesta y no emite otro evento Tiempo menor al mínimo plausible: rechazado
- [x] Tiempo mayor al transcurrido según el servidor: rechazado Jugador fuera del roster: rechazado
- [x] Cliente que no reporta: abandono al vencer el plazo — *F8 (2026-10-23) · hecha: test e2e `race_f1` y humo: carrera de 3 cuentas con un ausente `DNF` (T-06 2528ae5, d13bdb2)*
- [ ] Dos clientes con órdenes distintos: confianza client y marca de revisión — *F8 (2026-10-23) · descarte propuesto: el informe no lleva el orden visto por cada cliente; T-09 redefinió el quórum como ⌈n/2⌉ informes humanos (27c086c)*
- [ ] Corte de red al cruzar la meta: el resultado llega al recuperar la conexión — *F8 (2026-10-23) · pendiente del usuario: necesita clientes, redes o dispositivos reales (BackendSmoke y pruebas del usuario); el servidor ya cierra carreras de 3 cuentas en el humo*
### 1.7 Criterio de terminado
- [ ] Una carrera de 4 clientes reales produce un único resultado oficial con orden y confianza — *F8 (2026-10-23) · pendiente del usuario: necesita clientes, redes o dispositivos reales (BackendSmoke y pruebas del usuario); el servidor ya cierra carreras de 3 cuentas en el humo*
- [x] Un suscriptor de prueba recibe RaceCompleted una sola vez por carrera


---


- [ ] Ningún resultado imposible queda aceptado — *F8 (2026-10-23) · abierta: F9 T-30: cada vuelta solo exige > 0 (`[1,1,119998]` pasa); el umbral de clase ya sale del garaje (T-10 f2078a8)*
- [ ] El protocolo de carrera ya envía checkpoint y meta como mensajes propios — *F8 (2026-10-23) · decisión del usuario: F9-D4: protocolo de carrera con checkpoint y meta (hoy relay puro)*
## Fase 2 — Leaderboards y perfil
Objetivo: reconstruir las leaderboards desde cero para que solo las escriba el servidor a
partir de RaceCompleted, y dar a cada jugador un perfil público. La leaderboard actual
escrita por el cliente se descarta.
### 2.1 Contratos
- [x] Contrato escrito de lb_get (tabla, vista, cursor) y de profile_get / profile_update — *F8 (2026-10-23) · hecha: `lb_get` con cursor documentado (T-13 d813f2a, 38af983)*
- [ ] Forma única de fila de leaderboard: puesto, jugador, nombre, avatar, división, club, puntaje, metadata — *F8 (2026-10-23) · abierta: F9 T-32: filas con `username` (T-13) pero sin división ni club*
### 2.2 Servidor: módulo leaderboards
- [x] Catálogo leaderboards con el registro de tablas: patrón de ID, operador, orden, reinicio
- [x] Creación idempotente de todas las tablas al arrancar, como autoritativas
- [x] Tablas de tiempo por pista y clase: tt_{pista}_{clase}_all y tt_{pista}_{clase}_week Tablas de mejor vuelta: lap_{pista}_{clase}_all Tabla wins_week de victorias semanales
- [x] Suscripción a RaceCompleted: escribe tiempos, mejor vuelta y victorias según modo y confianza
- [ ] Regla de confianza: quorum y server entran siempre; client solo en contrarreloj validado y marcado en metadata — *F8 (2026-10-23) · abierta: F9 T-32: `lap_*` y `wins_week` se escriben con cualquier confianza (05 f7); falta el test con `client`*
- [ ] Metadata por registro: auto, plataforma, control, versión de cliente, ID de sesión — *F8 (2026-10-23) · abierta: F9 T-32: plataforma, control y versión siguen `unknown` en la metadata*
- [x] Tiempos guardados en milisegundos; subpuntaje con marca de tiempo para desempate lb_get vista global con paginación por cursor lb_get vista alrededor del jugador lb_get vista de amigos (lista de amigos más el jugador) — *F8 (2026-10-23) · 2.2.10 hecha: paginación con los cursores del runtime y orden de la tabla (T-13 d813f2a; humo b332212); 2.2.12 hecha: vista de amigos con `friends_edge` (T-13 d813f2a; humo b332212)*
- [x] Enriquecimiento de filas con datos de perfil en una sola lectura por lote
- [ ] Función removePlayerFromAll(userId) para retirar a un jugador de todas las tablas — *F8 (2026-10-23) · abierta: F9 T-32: `removePlayerFromAll` no saca de los leaderboards (05 f8); solo la purga de cuenta lo hace (T-16 ce6f9e4)*
- [x] Hook before que rechaza cualquier escritura de leaderboard hecha desde un cliente — *F8 (2026-10-23) · hecha: guard `registerBeforeWriteLeaderboardRecord` registrado en 3.27; el humo rechaza la escritura directa (T-01 918e5f7, 954b7a1; e0afd27)*
- [x] Borrado de la tabla antigua escrita por el cliente


---


### 2.3 Servidor: módulo progression (perfil)
- [ ] Objeto profile/main con nombre visible, avatar, nivel, XP, auto mostrado, plataforma — *F8 (2026-10-23) · descarte propuesto: la clave es `profiles/{userId}` y no hay auto mostrado ni plataforma; el cliente no los usa (aditivo si hace falta)*
- [x] Creación del perfil en el primer inicio de sesión (hook posterior a la autenticación) profile_get propio y de otro jugador (solo campos públicos) profile_update para nombre y avatar, con validación de longitud y caracteres — *F8 (2026-10-23) · 2.3.2 hecha: after-auth registrado y estado por VM: perfil y garaje al autenticar (T-01 918e5f7, T-29 5ea4f0b; humo f5d9f3b); 2.3.3 hecha: perfil ajeno = proyección pública, sin crear nada (T-14 36ca406; humo b332212)*
- [x] Lista básica de palabras bloqueadas aplicada al nombre
### 2.4 Cliente Unity
- [ ] Interfaces ILeaderboardService e IProfileService con implementación Nakama Eliminado todo envío de puntajes desde el cliente
- [ ] Pantalla de leaderboards: selector de pista, clase y periodo (semana, histórico)
- [ ] Pestañas global, alrededor de mí y amigos, con paginación Fila del jugador siempre visible y resaltada
- [ ] Formato de tiempo mm:ss.mmm a partir de milisegundos
- [ ] Pantalla de perfil propio con edición de nombre y avatar
- [ ] Ficha de perfil de otro jugador desde cualquier fila
- [ ] Aviso de mejor marca personal en la pantalla de resultados Estados de carga, vacío y error en cada vista
### 2.5 Pruebas
- [x] Una carrera válida actualiza tiempo por pista, mejor vuelta y victorias
- [x] Un tiempo peor que el registrado no reemplaza la marca
- [ ] Un resultado con confianza client en carrera con rivales no entra a las tablas de tiempo — *F8 (2026-10-23) · abierta: F9 T-32: `lap_*` y `wins_week` se escriben con cualquier confianza (05 f7); falta el test con `client`*
- [x] Escritura directa desde un cliente: rechazada por el hook — *F8 (2026-10-23) · hecha: guard `registerBeforeWriteLeaderboardRecord` registrado en 3.27; el humo rechaza la escritura directa (T-01 918e5f7, 954b7a1; e0afd27)*
- [x] Reinicio semanal simulado en local: la tabla semanal queda vacía y la histórica intacta
- [x] Vista alrededor de mí con el jugador en el primer puesto, en el último y sin registro Nombre con palabra bloqueada: rechazado
### 2.6 Criterio de terminado
- [x] Terminar una carrera actualiza las tablas sin que el cliente envíe puntajes
- [x] Las tres vistas responden con filas enriquecidas en una sola llamada — *F8 (2026-10-23) · hecha: las tres vistas con nombres y cursor (T-13 d813f2a)*
- [x] No queda ninguna tabla que un cliente pueda escribir
- [x] Cada jugador tiene perfil y puede ver el de los demás — *F8 (2026-10-23) · hecha: after-auth registrado y estado por VM: perfil y garaje al autenticar (T-01 918e5f7, T-29 5ea4f0b; humo f5d9f3b)*


---


## Fase 3 — Economía, garaje y progresión
Objetivo: que correr dé monedas y XP, y que eso se convierta en autos, mejoras y
cosméticos que los rivales ven aplicados en la carrera.
### 3.1 Diseño y contratos
- [x] Hoja de cálculo de economía: monedas por hora de juego, costo de cada auto y mejora, días hasta el primer auto nuevo (objetivo: 2 a 3) — escrito en `docs/economy.md#economy-spreadsheet` (2026-10-06); **GAP detectado**: casual 1 h/día tarda 8-9 días en `civic_r` (objetivo 2-3 no se cumple con catálogo actual) — recomendado en sección I
- [x] Lista de los 6 autos iniciales (o más) con clase y estadísticas base y tope
- [x] Lista inicial de cosméticos por tipo: pintura, llantas, calcomanía, estela, bocina
- [x] Tabla de XP por nivel (1 a 50) y desbloqueos por nivel
- [x] Contrato escrito de garage_get, car_buy, car_upgrade, cosmetic_equip, loadout_set, store_get, store_buy, wallet_get — §16.1-§16.8 de `docs/unity-api.md` (Phase 3 wrap-up); errores y edge cases en `docs/economy.md`, `docs/garage.md`, `docs/store.md`
### 3.2 Servidor: módulo economy
- [x] Monedas coins y gems en el wallet de Nakama
- [x] Función única grant(userId, recompensa, motivo, claveIdempotencia) usada por todos los módulos — *F8 (2026-10-23) · hecha: clave duradera `idem/` en el mismo `multiUpdate` que el wallet (T-11 7cd00c9; humo aa55f7a)*
- [x] Función única spend(userId, costo, motivo) que falla si el saldo no alcanza
- [x] Motivo e ID de origen en la metadata de cada movimiento del ledger — *F8 (2026-10-23) · hecha: cada movimiento escribe su fila de ledger con `reason` e `idempotencyKey` en el `multiUpdate` (T-11 7cd00c9; humo aa55f7a)*
- [ ] Tipo Reward común: monedas, gemas, XP, auto, cosmético; un solo punto que sabe entregar cada tipo — *F8 (2026-10-23) · descarte propuesto: las entregas ya convergen en `moveWallet` + `garage/delivery.ts` en una transacción (T-11, T-17, T-19); unificar más es un refactor sin efecto*
- [x] Catálogo rewards: base por posición para 2, 4 y 6 autos, multiplicadores por modo, bonos
- [ ] Suscripción a RaceCompleted: paga monedas y XP por posición, con el ID de sesión como clave de idempotencia — *F8 (2026-10-23) · abierta: F9 T-30: el pago es síncrono en `race/close.ts` con clave por sesión, pero los suscriptores `race.completed` siguen muertos y la XP no tiene clave (05 f16)*
- [ ] Bono de primera victoria del día con sello de fecha UTC — *F8 (2026-10-23) · abierta: F9 T-31: el bono se da a la primera carrera del día, no a la primera victoria*
- [ ] Premio reducido en sala privada y tope diario de carreras privadas premiadas — *F8 (2026-10-23) · abierta: F9 T-31: `dailyPrivateCount` nunca se reinicia y el tope no se aplica*
- [x] Catálogo store: secciones, ofertas, precios, requisitos de nivel, vigencia
- [x] Oferta diaria rotativa con semilla por fecha (FNV-1a sobre UTC day index)
- [x] store_get filtrado por nivel, propiedad y eventos activos
- [x] store_buy con verificación de vigencia y requisitos, cobro y entrega con refund-on-CAS-conflict (D3 workaround) — *F8 (2026-10-23) · hecha: cobro y entrega en una transacción, sin reembolso con `grant` negativo (T-11 691bd42) y precio mostrado = cobrado (T-12 eba8cc8; humo aa55f7a)*
- [x] wallet_get con saldos


---


### 3.3 Servidor: módulo garage
- [x] Catálogo cars: id, clase, estadísticas base, estadísticas tope, precio, nivel requerido
- [x] Catálogo upgrades: 4 líneas, 5 niveles, costo y efecto por nivel
- [x] Catálogo cosmetics: id, tipo, rareza, precio, autos compatibles
- [x] Objeto garage/cars con autos poseídos, niveles de mejora y cosméticos
- [x] Auto inicial entregado al crear la cuenta — *F8 (2026-10-23) · hecha: el after-auth crea el garaje (T-29 5ea4f0b; humo f5d9f3b)*
- [x] garage_get con el garaje completo y las estadísticas calculadas de cada auto
- [x] car_buy: nivel requerido, no poseído, cobro y entrega atómica (spend-first + CAS-write + grant-refund-on-conflict; D3 caveat — Nakama 3.27 JS runtime no soporta wallet ops dentro de multiUpdate) — *F8 (2026-10-23) · hecha: cobro y entrega en una transacción, sin reembolso con `grant` negativo (T-11 691bd42) y precio mostrado = cobrado (T-12 eba8cc8; humo aa55f7a)*
- [x] car_upgrade: siguiente nivel de una línea, sin superar el tope de clase
- [x] cosmetic_equip con verificación de propiedad y compatibilidad (D4 Strict)
- [ ] loadout_set: valida propiedad y escribe garage/loadout público (D5) — *F8 (2026-10-23) · descarte propuesto: el loadout vive en `garage/{userId}`; los rivales lo leen de la sesión, que lo copia del garaje (T-10 f2078a8)*
- [x] Función computeStats(auto, mejoras) compartida, y variante igualada al tope de clase para ranked
- [x] La sesión de carrera copia el loadout y las estadísticas de cada jugador al fijarse — *F8 (2026-10-23) · hecha: clase, coche y estadísticas del garaje en create/join/quick_bots/matchmaker (T-10 f2078a8, T-09 27c086c); la librea es cosmética y se respeta*
### 3.4 Servidor: módulo progression
- [ ] Suscripción a RaceCompleted: suma XP — *F8 (2026-10-23) · abierta: F9 T-30: el pago es síncrono en `race/close.ts` con clave por sesión, pero los suscriptores `race.completed` siguen muertos y la XP no tiene clave (05 f16)*
- [x] Subida de nivel, incluso varios niveles de una vez, con su premio por nivel
- [x] Desbloqueos por nivel leídos del catálogo y expuestos en profile_get
- [ ] La respuesta de resultados incluye monedas, XP, niveles subidos y desbloqueos nuevos — *F8 (2026-10-23) · abierta: F9 T-30: la respuesta no lista desbloqueos ni el cambio de rating (con 4.4.11)*
### 3.5 Cliente Unity
- [ ] Interfaces IEconomyService, IGarageService, IStoreService con implementación Nakama
- [ ] Saldos visibles en el menú, actualizados tras cada RPC que los cambia
- [ ] Pantalla de garaje: lista de autos, estadísticas en barras, estado bloqueado, comprable o poseído
- [ ] Compra de auto con confirmación y mensaje de saldo insuficiente
- [ ] Pantalla de mejoras: 4 líneas, costo del siguiente nivel, vista previa del cambio de estadísticas
- [ ] Pantalla de personalización: cosméticos por tipo con vista previa en el auto
- [ ] Selección de auto activo antes de entrar a una carrera


---


- [ ] Autos rivales construidos con el loadout y las estadísticas de la sesión, no con datos enviados por el rival
- [ ] Tienda: secciones, oferta diaria con cuenta regresiva, compra con confirmación
- [ ] Pantalla de resultados con monedas, XP, barra de nivel y desbloqueos Pantalla de subida de nivel
- [ ] El cliente nunca calcula precios ni premios: solo muestra lo que devuelve el servidor
### 3.6 Pruebas
- [x] Pruebas unitarias de computeStats, premios por posición y subida de nivel Comprar sin saldo: rechazado, sin cambios Comprar un auto ya poseído: rechazado Mejorar por encima del nivel 5: rechazado Equipar un cosmético no poseído: rechazado
- [ ] Fallo forzado entre cobro y entrega: no queda cobro sin entrega — *F8 (2026-10-23) · abierta: F9 T-31: `refund-safety.test.ts` sigue comparando la misma referencia; el camino ya es atómico (T-11 691bd42)*
- [ ] El mismo RaceCompleted procesado dos veces paga una sola vez — *F8 (2026-10-23) · abierta: F9 T-30: el pago es síncrono en `race/close.ts` con clave por sesión, pero los suscriptores `race.completed` siguen muertos y la XP no tiene clave (05 f16)*
- [x] Cambiar el precio en el catálogo se refleja en el cliente sin build
- [ ] Jugador nuevo simulado: llega al primer auto nuevo en el plazo objetivo — *F8 (2026-10-23) · decisión del usuario: F9-D2: la economía da 8-9 días hasta el primer coche (objetivo 2-3)*
### 3.7 Criterio de terminado
- [ ] Un jugador nuevo gana monedas corriendo, compra un auto, lo mejora y lo personaliza — *F8 (2026-10-23) · abierta: F9 T-31: falta un e2e carrera → `car_buy` → mejora → `cosmetic_equip`*
- [x] Los rivales ven ese auto con sus estadísticas y cosméticos leídos de la sesión — *F8 (2026-10-23) · hecha: clase, coche y estadísticas del garaje en create/join/quick_bots/matchmaker (T-10 f2078a8, T-09 27c086c); la librea es cosmética y se respeta*
- [x] Cada movimiento del wallet aparece en el ledger con su motivo — *F8 (2026-10-23) · hecha: cada movimiento escribe su fila de ledger con `reason` e `idempotencyKey` en el `multiUpdate` (T-11 7cd00c9; humo aa55f7a)*
- [ ] Ningún precio ni premio está escrito en el código del cliente — *F8 (2026-10-23) · criterio del cliente: criterio del código del cliente; el servidor manda precios y premios desde los catálogos*
## Fase 4 — Matchmaking y ranked
Objetivo: que un jugador entre a una cola y termine en una carrera de 2, 4 o 6 autos con
rivales de su nivel, con bots cuando falte gente en carrera rápida, y que el ranked mueva
un rating confiable.
### 4.1 Diseño y contratos
- [ ] Propiedades y consulta del ticket escritas para cada modo: mode, version, region, size, rating, class, platform, input, rtt — `docs/matchmaking.md#ticket-properties` — *F8 (2026-10-23) · abierta: F9 T-34: sin propiedades numéricas (rating, rtt), clase, plataforma ni min/max del matchmaker en el ticket*
- [ ] Regla de tamaños: en rápida el jugador elige 2, 4 o 6 y los bots completan; en ranked hay una sola cola sin bots que forma carreras de 2, 4 o 6 humanos (mínimo 2, máximo 6, múltiplos de 2) — `docs/matchmaking.md#size-rules` — *F8 (2026-10-23) · abierta: F9 T-34: sin propiedades numéricas (rating, rtt), clase, plataforma ni min/max del matchmaker en el ticket*


---


- [x] Contrato escrito de ranked_get, mm_ticket_params y race_session_quick_bots — §17 `docs/unity-api.md` + `docs/matchmaking.md` + `docs/ranked.md`
- [ ] Parámetros de rating en el catálogo ranked: K inicial y normal, rating inicial, límites de división — `modules/src/catalogs/ranked.json` + `tests/unit/rating.test.ts` — *F8 (2026-10-23) · decisión del usuario: F9-D2: K 40/24 y 5 divisiones frente a 48/32 y 6 del plan; la fórmula no divide por N-1*
### 4.2 Servidor: módulo matchmaking
- [x] mm_ticket_params: devuelve al cliente las propiedades y la consulta que debe usar, según modo y configuración
- [x] Hook matchmakerMatched: valida que todos los tickets coincidan en modo, versión y región — *F8 (2026-10-23) · hecha: hook con la firma real de 3.27: valida y crea la sesión con el roster (T-09 27c086c; humo d13bdb2)*
- [x] El hook crea la RaceSession con el roster emparejado y deja el match como relay — *F8 (2026-10-23) · hecha: hook con la firma real de 3.27: valida y crea la sesión con el roster (T-09 27c086c; humo d13bdb2)*
- [ ] Elección de pista: aleatoria entre las desbloqueadas por todos, sin repetir la última de cada jugador — FNV-1a (`modules/src/matchmaking/track_picker.ts`) — *F8 (2026-10-23) · abierta: F9 T-34: el hook elige pista sin historial por jugador ni desbloqueos*
- [ ] Elección de host por menor rtt y lista de sucesión ordenada — *F8 (2026-10-23) · abierta: F9 T-34: el ticket no lleva `rtt`; el host del matchmaker no sale del menor rtt*
- [x] Relleno con bots: la sesión indica cuántos bots y de qué dificultad según el rating medio race_session_quick_bots: crea una sesión de carrera rápida de un humano con bots cuando la cola vence sin rivales
- [ ] Soporte de Parties: el grupo entra con un solo ticket y su rating es el más alto de sus miembros — Phase 7 — *F8 (2026-10-23) · abierta: F9 T-34: rating de la party = el del líder, no el máximo*
- [ ] Clave mm.segmentBy en liveops/config con valores none, input, platform — *F8 (2026-10-23) · abierta: F9 T-34: `mm.segmentBy` de LiveOps no llega al ticket*
- [ ] Tiempos de espera y ventanas de rating en configuración remota — `modules/src/catalogs/liveops.json` — *F8 (2026-10-23) · abierta: F9 T-34: dos copias de las ventanas de rating; la de LiveOps no se usa (los tiempos de 10/20/60 s son del cliente)*
- [ ] Evento de analítica por emparejamiento: tiempo en cola, humanos, bots, diferencia de rating — Phase 5 (analítica events) — *F8 (2026-10-23) · abierta: F9 T-34: no se mide el tiempo en cola*
### 4.3 Servidor: reconexión y abandono
- [x] race_session_get devuelve ID de match y estado para reincorporarse — *F8 (2026-10-23) · hecha: reingreso con `race_session_get` sin id (T-08 48e516f; humo d13bdb2)*
- [x] Marca de desconexión por jugador reportada por el host, con hora del servidor — *F8 (2026-10-23) · hecha: sustituida por el último contacto que mide el servidor (`race_presence`, T-07 b6f37d4); `reportDisconnect` queda muerto (F9 T-30)*
- [x] Gracia de 20 s; pasado ese tiempo el jugador queda como abandono — *F8 (2026-10-23) · hecha: gracia de 30 s (`CLOSE_GRACE_MS`) y ausente `DNF` último (T-06 2528ae5; humo d13bdb2)*
- [x] RPC race_host_claim: el siguiente en la sucesión toma el rol de host; el servidor lo confirma una sola vez — *F8 (2026-10-23) · hecha: reclamación por el primer vivo de la sucesión, `NOT_HOST` con el host vivo (T-07 b6f37d4; humo d13bdb2)*
- [ ] Contador de abandonos en ranked por 24 h y bloqueo de cola de 15 minutos al tercero — *F8 (2026-10-23) · abierta: F9 T-32: el bloqueo de 15 min solo se muestra en `ranked_get`; nada lo aplica en la cola*
### 4.4 Servidor: módulo ranked
- [ ] Objeto ranked/s{N} por jugador: rating, división, división más alta, carreras jugadas Catálogo seasons con la temporada 1 y sus fechas — `modules/src/ranked/storage.ts` + seassons 1+2 en `modules/src/catalogs/seasons.json` — *F8 (2026-10-23) · 4.4.1 descarte propuesto: un objeto `ranked/{userId}` migrado por temporada con `peak`; separarlo por temporada no cambia nada al cliente; 4.4.2 decisión del usuario: F9-D1: `season_1` (2025) y `season_2` (2025-2028, solapada) en `seasons.json`*
- [ ] Función de rating para N humanos según la fórmula del plan, con pruebas unitarias — `tests/unit/rating.test.ts` cubre 2/4/6 humanos + abandonos + empates — *F8 (2026-10-23) · decisión del usuario: F9-D2: K 40/24 y 5 divisiones frente a 48/32 y 6 del plan; la fórmula no divide por N-1*


---


- [x] Suscripción a RaceCompleted en modo ranked: calcula y guarda el cambio de rating de cada humano — Chunk 7
- [x] Solo resultados con confianza quorum o server mueven rating El abandono cuenta como último lugar Tabla ranked_s1 actualizada con operador set — Chunk 7+8 — *F8 (2026-10-23) · hecha: tabla ranked `desc` declarada en `leaderboards.json` y recreada si no coincide (T-13 d813f2a; humo b332212)*
- [x] Estadísticas igualadas al tope de clase en las sesiones ranked — Chunk 8 (loadoutStatsFor + computeStatsForRanked)
- [ ] Ranked bloqueado hasta el nivel 5 ranked_get: rating, división, progreso a la siguiente, puesto en la tabla, días restantes de temporada — Chunk 6 (`ranked_get` RPC + level gate) — *F8 (2026-10-23) · 4.4.9 abierta: F9 T-32: ranked sin puerta de nivel 5; 4.4.10 hecha: `ranked_get` lee el registro del dueño, rango 1 = mejor rating (T-13 d813f2a); el cierre de temporada aún pide 10 000 filas (F9 T-33)*
- [ ] La respuesta de resultados incluye rating anterior, nuevo y cambio de división — Chunk 7 (RaceCompleted payload) — *F8 (2026-10-23) · abierta: F9 T-30: la respuesta no trae rating anterior/nuevo ni cambio de división (la fórmula depende de F9-D2)*
### 4.5 Cliente Unity
- [ ] Interfaces IMatchmakingService e IRankedService con implementación Nakama
- [ ] Medición de rtt contra el servidor antes de entrar a la cola Pantalla de selección de modo y tamaño (2, 4, 6)
- [ ] Pantalla de cola con tiempo transcurrido y botón de cancelar
- [ ] Ampliación de ventana de rating: cancelar y reenviar el ticket cada 10 s
- [ ] Carrera rápida: a los 20 s sin rivales suficientes, arrancar con bots
- [ ] Ranked: a los 60 s sin emparejar, ofrecer carrera rápida
- [ ] Al emparejar: unirse al match, leer la sesión, cargar pista y autos
- [ ] El host instancia los bots indicados por la sesión con la IA del sistema de conducción
- [ ] Reincorporación al abrir el juego si race_session_get reporta una carrera viva
- [ ] Autodrive en el host para el auto de un jugador desconectado durante la gracia
- [ ] Migración de host: detectar la caída, llamar race_host_claim, asumir bots y autodrive
- [ ] Grupos: crear, invitar por código, entrar juntos a la cola
- [ ] Pantalla ranked: división, barra de progreso, puesto, cuenta regresiva de temporada
- [ ] Animación de cambio de rating y de división en resultados Aviso de bloqueo de cola por abandonos
### 4.6 Pruebas
- [x] Pruebas unitarias de rating con 2, 4 y 6 humanos, incluyendo empates de rating y abandonos — `tests/unit/rating.test.ts`, `tests/unit/division.test.ts`
- [ ] 6 clientes en cola rápida de tamaño 6: una sola carrera con todos — `tests/e2e/matchmaking_full.test.ts` — *F8 (2026-10-23) · pendiente del usuario: necesita clientes, redes o dispositivos reales (BackendSmoke y pruebas del usuario); el servidor ya cierra carreras de 3 cuentas en el humo*
- [ ] 3 clientes en cola rápida de tamaño 4: carrera con 3 humanos y 1 bot al vencer la espera 1 cliente solo: carrera con bots a los 20 s — `tests/e2e/matchmaking_full.test.ts` — *F8 (2026-10-23) · 4.6.3 criterio del cliente: la espera de 20 s y el relleno con bots los decide el cliente; el servidor (`race_session_quick_bots`) tiene tests; 4.6.4 criterio del cliente: la espera de 20 s y el relleno con bots los decide el cliente; el servidor (`race_session_quick_bots`) tiene tests*


---


- [ ] 5 clientes en cola ranked: carrera de 4 humanos y uno sigue en cola Clientes con versión distinta nunca se emparejan Clientes de distinta región nunca se emparejan — `tests/e2e/ranked_full.test.ts` — *F8 (2026-10-23) · 4.6.5 pendiente del usuario: necesita clientes, redes o dispositivos reales (BackendSmoke y pruebas del usuario); el servidor ya cierra carreras de 3 cuentas en el humo; 4.6.6 abierta: F9 T-34: el servidor sella versión `1.0.0` y región fija para todos; 4.6.7 abierta: F9 T-34: el servidor sella versión `1.0.0` y región fija para todos*
- [ ] Grupo de 2 más 2 sueltos: los del grupo quedan en la misma carrera — Phase 7 (clubs+parties) — *F8 (2026-10-23) · abierta: F9 T-34: humo con party de 2 + 2 sueltos (el humo ya prueba 2 sockets → misma sesión, d13bdb2)*
- [x] Desconexión de 10 s: el jugador vuelve y termina la carrera Desconexión de 30 s: abandono y último lugar — `tests/e2e/host_recovery.test.ts` — *F8 (2026-10-23) · 4.6.9 hecha: el jugador vuelve con `race_session_get` sin id y su informe se acepta antes del cierre (T-08, T-06; humo d13bdb2); 4.6.10 hecha: gracia de 30 s (`CLOSE_GRACE_MS`) y ausente `DNF` último (T-06 2528ae5; humo d13bdb2)*
- [x] Caída del host a mitad de carrera: la carrera continúa con el sucesor — `tests/e2e/host_recovery.test.ts` — *F8 (2026-10-23) · hecha: reclamación por el primer vivo de la sucesión, `NOT_HOST` con el host vivo (T-07 b6f37d4; humo d13bdb2)*
- [ ] Tres abandonos en ranked: cola bloqueada 15 minutos — `tests/e2e/abandon_block_full.test.ts` — *F8 (2026-10-23) · abierta: F9 T-32: el bloqueo de 15 min solo se muestra en `ranked_get`; nada lo aplica en la cola*
- [ ] Con 150 ms de latencia y 5 % de pérdida simulados, la carrera sigue siendo jugable — cliente Unity scope — *F8 (2026-10-23) · pendiente del usuario: casilla sin marcar: latencia y pérdida emuladas con clientes reales*
### 4.7 Criterio de terminado
- [ ] La cola rápida arranca una carrera en 20 s o menos, con bots si hace falta — *F8 (2026-10-23) · criterio del cliente: la espera de 20 s y el relleno con bots los decide el cliente; el servidor (`race_session_quick_bots`) tiene tests*
- [ ] Una carrera ranked de 4 humanos cambia los ratings según la fórmula y actualiza ranked_s1 — *F8 (2026-10-23) · abierta: F9 T-30: la respuesta no trae rating anterior/nuevo ni cambio de división (la fórmula depende de F9-D2)*
- [x] Un jugador que pierde conexión vuelve a su carrera dentro de la gracia La caída del host no termina la carrera — *F8 (2026-10-23) · 4.7.3 hecha: reingreso con `race_session_get` sin id (T-08 48e516f; humo d13bdb2); 4.7.4 hecha: reclamación por el primer vivo de la sucesión, `NOT_HOST` con el host vivo (T-07 b6f37d4; humo d13bdb2)*
- [x] Las salas privadas siguen funcionando con el flujo de la Fase 1
## Fase 5 — Operación y lanzamiento en pruebas
Objetivo: pasar de un servidor de desarrollo a uno que aguante jugadores reales en
América y Europa, con cuentas que siguen al jugador entre móvil y PC. Al terminar esta
fase el juego se puede publicar en pruebas.
### 5.1 Infraestructura
- [ ] Tres entornos separados (local, staging, producción), cada uno con su base de datos y sus claves — *F8 (2026-10-23) · pendiente del usuario: entornos, copias restauradas y latencias reales: infraestructura del usuario (F9 T-42 da el procedimiento)*
- [ ] Claves por defecto cambiadas en staging y producción: server key, HTTP key, clave de firma de sesión, usuario y contraseña de la consola — *F8 (2026-10-23) · pendiente del usuario: sin secretos en el bundle (relay T-01 918e5f7, enlace T-15 ce6f9e4); las claves de producción las cambia el usuario*
- [x] Secretos fuera del repositorio, inyectados por variables de entorno
- [ ] Proxy inverso con TLS delante de Nakama (API y socket) — *F8 (2026-10-23) · pendiente del usuario: TLS en Cloudflare y acceso a la consola: infraestructura del servidor (F9-D7)*
- [ ] Consola de Nakama accesible solo por VPN o lista de IPs — *F8 (2026-10-23) · pendiente del usuario: TLS en Cloudflare y acceso a la consola: infraestructura del servidor (F9-D7)*
- [ ] PostgreSQL administrado o con copia automática diaria y retención de 14 días Restauración de una copia probada en staging — *F8 (2026-10-23) · 5.1.6 abierta: F9 T-42: copias diarias, procedimiento de despliegue/vuelta atrás, paneles y alertas; 5.1.7 pendiente del usuario: entornos, copias restauradas y latencias reales: infraestructura del usuario (F9 T-42 da el procedimiento)*
- [ ] Pipeline: compila TypeScript, corre pruebas, construye la imagen Docker con versión, despliega a staging — *F8 (2026-10-23) · decisión del usuario: F9-D7: pipeline de CI/CD y logs centralizados*


---


- [ ] Despliegue a producción con un paso manual de aprobación — *F8 (2026-10-23) · decisión del usuario: F9-D7: pipeline de CI/CD y logs centralizados*
- [ ] Procedimiento escrito de despliegue y de vuelta atrás — *F8 (2026-10-23) · abierta: F9 T-42: copias diarias, procedimiento de despliegue/vuelta atrás, paneles y alertas*
- [ ] Métricas de Nakama exportadas a Prometheus, con panel de sesiones, latencia de RPC, errores, CPU, memoria y conexiones a la base — *F8 (2026-10-23) · abierta: F9 T-42: copias diarias, procedimiento de despliegue/vuelta atrás, paneles y alertas*
- [ ] Alertas: servidor caído, tasa de errores, latencia alta, disco de la base — *F8 (2026-10-23) · abierta: F9 T-42: copias diarias, procedimiento de despliegue/vuelta atrás, paneles y alertas*
- [ ] Logs centralizados y buscables por ID de sesión de carrera y por jugador Límite de frecuencia activo en todos los RPC — *F8 (2026-10-23) · 5.1.13 decisión del usuario: F9-D7: pipeline de CI/CD y logs centralizados; 5.1.14 abierta: F9 T-41: `checkRateLimit` solo en 13 módulos; faltan dinero, perfil, bandeja, cuentas, torneos, IAP y anuncios*
### 5.2 Regiones: América y Europa
- [ ] Servidor principal (cuentas y metajuego) desplegado en la costa este de Estados Unidos — *F8 (2026-10-23) · pendiente del usuario: entornos, copias restauradas y latencias reales: infraestructura del usuario (F9 T-42 da el procedimiento)*
- [ ] Prueba de concepto de nodo de relay en Europa: segundo Nakama solo para cola y carrera, con el servidor principal como única fuente de cuentas y datos — *F8 (2026-10-23) · fuera de alcance: relay regional eliminado por decisión del usuario (D-01, T-01 918e5f7)*
- [ ] Variable NODE_ROLE (home o relay) que decide qué módulos registra cada nodo — *F8 (2026-10-23) · fuera de alcance: relay regional eliminado por decisión del usuario (D-01, T-01 918e5f7)*
- [x] RPC relay_token en el principal: emite un token firmado de corta duración con el ID del jugador y su región
- [x] Autenticación en el nodo de relay validando ese token en un hook previo a la autenticación
- [ ] En el nodo de relay, el hook matchmakerMatched crea la sesión llamando al principal de servidor a servidor con la HTTP key config_get devuelve la lista de regiones con su dirección de relay — *F8 (2026-10-23) · 5.2.6 fuera de alcance: relay regional eliminado por decisión del usuario (D-01, T-01 918e5f7); 5.2.7 fuera de alcance: relay regional eliminado por decisión del usuario (D-01, T-01 918e5f7)*
- [x] Decisión registrada tras la prueba: relay regional (recomendado) o dos despliegues independientes por región como alternativa — *F8 (2026-10-23) · hecha: decisión registrada: sin relay regional, regiones con Unity Relay (plan D-01, 2026-10-22)*
- [ ] Latencia medida desde Colombia, México, Brasil, España y Alemania hacia cada región — *F8 (2026-10-23) · pendiente del usuario: entornos, copias restauradas y latencias reales: infraestructura del usuario (F9 T-42 da el procedimiento)*
### 5.3 Cuentas en móvil y PC
- [x] Móvil: inicio como invitado con ID de dispositivo
- [ ] PC: método de acceso definido según la tienda elegida (cuenta de la tienda o correo) — *F8 (2026-10-23) · fuera de alcance: PC/Steam con compras fuera de alcance (plan §1)*
- [x] Enlace de Google, Apple y correo a una cuenta existente — *F8 (2026-10-23) · hecha: vinculación nativa y conflicto en dos pasos (T-15 ce6f9e4; humo 6f94648); falta la prueba humana con Apple/Google*
- [x] Inicio de sesión desde otra plataforma con un método enlazado, recuperando todo el progreso — *F8 (2026-10-23) · hecha: vinculación nativa y conflicto en dos pasos (T-15 ce6f9e4; humo 6f94648); falta la prueba humana con Apple/Google*
- [x] Conflicto de enlace: el servidor devuelve el resumen de ambas cuentas para que el jugador elija account_delete con confirmación y borrado de datos personales — *F8 (2026-10-23) · 5.3.5 hecha: vinculación nativa y conflicto en dos pasos (T-15 ce6f9e4; humo 6f94648); falta la prueba humana con Apple/Google; 5.3.6 hecha: purga de las 60 colecciones, leaderboards y amistades (T-16 ce6f9e4; humo 6f94648: 0 objetos)*
- [x] Aviso de enlazar cuenta desde el nivel 5 con premio único al enlazar


---


### 5.4 Servidor: LiveOps base, inbox y analítica
- [x] Objeto liveops/config con flags, valores ajustables y calendario vacío, servido por config_get
- [x] Flag de mantenimiento con mensaje y lista de jugadores exentos Versión mínima de cliente por plataforma
- [x] Módulo inbox: correo con premio adjunto y vencimiento, inbox_list, inbox_claim idempotente — *F8 (2026-10-23) · hecha: una sola bandeja con reclamo atómico (T-17 bcfad56; humo 6f94648)*
- [ ] RPCs de soporte protegidos con HTTP key: dar y quitar objetos, enviar correo a uno o a todos, marcar y sancionar — *F8 (2026-10-23) · abierta: F9 T-41: faltan dar/quitar coches y cosméticos y el envío a `all` (`NOT_IMPLEMENTED`)*
- [ ] Eventos de analítica desde el servidor: registro, sesión, carrera completada, movimiento de wallet, compra en tienda, emparejamiento Destino de analítica elegido y conectado — *F8 (2026-10-23) · 5.4.6 abierta: F9 T-41: falta un evento de registro/inicio de sesión (la lectura pública se cerró en T-18 1effa13); 5.4.7 decisión del usuario: F9-D7: destino de analítica*
- [ ] RPC de soporte para limpiar sesiones de carrera con más de 7 días — *F8 (2026-10-23) · abierta: F9 T-41: `admin_cleanup_race_sessions` borra todas las cerradas sin mirar la edad*
### 5.5 Cliente Unity
- [ ] Selector de entorno por configuración de build
- [ ] Dos conexiones: principal siempre, relay regional durante cola y carrera
- [ ] Elección automática de región por menor latencia, con cambio manual en ajustes
- [ ] Reconexión automática del socket principal con espera creciente
- [ ] Pantalla de ajustes de cuenta: métodos enlazados, enlazar, cerrar sesión, borrar cuenta Pantalla de conflicto de enlace
- [ ] Pantallas de mantenimiento y de actualización obligatoria
- [ ] Inbox con indicador de no leídos y reclamo de premios
- [ ] Eventos de analítica de cliente: embudo del primer inicio, pantallas, rendimiento Reporte de errores y caídas del cliente
- [ ] Builds de Android, iOS y PC apuntando a producción
### 5.6 Publicación en pruebas
- [ ] Política de privacidad y términos de uso publicados y enlazados desde el juego — *F8 (2026-10-23) · pendiente del usuario: casilla sin marcar: publicación en las tiendas (políticas, formularios, canales de prueba)*
- [ ] Clasificación por edad y formularios de datos de cada tienda completados — *F8 (2026-10-23) · pendiente del usuario: casilla sin marcar: publicación en las tiendas (políticas, formularios, canales de prueba)*
- [ ] Canal de pruebas configurado en cada tienda (pruebas cerradas o acceso anticipado) Canal para reportes de los jugadores de prueba — *F8 (2026-10-23) · 5.6.3 pendiente del usuario: casilla sin marcar: publicación en las tiendas (políticas, formularios, canales de prueba); 5.6.4 pendiente del usuario: casilla sin marcar: publicación en las tiendas (políticas, formularios, canales de prueba)*
### 5.7 Pruebas
- [x] Cliente sin gráficos que inicia sesión, entra a cola, corre y reporta resultado — *F8 (2026-10-23) · hecha: `npm run smoke:live`: login, matchmaker por socket, carreras e informes contra el runtime real (T-05 e0afd27, d13bdb2)*


---


- [ ] Prueba de carga: 500 jugadores simultáneos en carreras de 6 durante 1 hora, sin errores ni degradación — *F8 (2026-10-23) · abierta: F9 T-43: prueba de carga y de resistencia (objetivo y entorno: F9-D7)*
- [ ] Prueba de resistencia: 100 jugadores durante 12 horas sin crecimiento de memoria — *F8 (2026-10-23) · abierta: F9 T-43: prueba de carga y de resistencia (objetivo y entorno: F9-D7)*
- [ ] Despliegue y vuelta atrás ejecutados siguiendo el procedimiento — *F8 (2026-10-23) · pendiente del usuario: entornos, copias restauradas y latencias reales: infraestructura del usuario (F9 T-42 da el procedimiento)*
- [ ] Carrera entre dos jugadores de Europa por el relay europeo con el metajuego en el principal — *F8 (2026-10-23) · fuera de alcance: relay europeo eliminado (D-01)*
- [ ] Cuenta creada en Android, enlazada y abierta en PC con el mismo progreso — *F8 (2026-10-23) · pendiente del usuario: necesita clientes, redes o dispositivos reales (BackendSmoke y pruebas del usuario); el servidor ya cierra carreras de 3 cuentas en el humo*
- [x] Borrado de cuenta: los datos desaparecen y el jugador sale de las tablas — *F8 (2026-10-23) · hecha: purga de las 60 colecciones, leaderboards y amistades (T-16 ce6f9e4; humo 6f94648: 0 objetos)*
- [x] Modo mantenimiento activado y desactivado sin reiniciar el servidor
### 5.8 Criterio de terminado
- [ ] La prueba de carga pasa y su resultado queda documentado como techo conocido Se restauró una copia de la base en staging — *F8 (2026-10-23) · 5.8.1 abierta: F9 T-43: prueba de carga y de resistencia (objetivo y entorno: F9-D7); 5.8.2 pendiente del usuario: entornos, copias restauradas y latencias reales: infraestructura del usuario (F9 T-42 da el procedimiento)*
- [ ] Jugadores de América y de Europa corren con latencia aceptable en su región — *F8 (2026-10-23) · pendiente del usuario: entornos, copias restauradas y latencias reales: infraestructura del usuario (F9 T-42 da el procedimiento)*
- [ ] Un jugador continúa su progreso al cambiar de móvil a PC — *F8 (2026-10-23) · pendiente del usuario: necesita clientes, redes o dispositivos reales (BackendSmoke y pruebas del usuario); el servidor ya cierra carreras de 3 cuentas en el humo*
- [ ] El juego está disponible para jugadores de prueba en al menos una tienda móvil y en PC — *F8 (2026-10-23) · pendiente del usuario: necesita clientes, redes o dispositivos reales (BackendSmoke y pruebas del usuario); el servidor ya cierra carreras de 3 cuentas en el humo*
## Fase 6 — Misiones, logros y pase
Objetivo: dar motivos para volver cada día y una meta de 6 semanas, y cerrar la primera
temporada de ranked con sus premios.
### 6.1 Diseño y contratos
- [x] Lista de al menos 20 misiones diarias y 10 semanales con filtros, meta y premio Lista de al menos 20 logros permanentes
- [x] Tabla del pase: 40 niveles, XP por nivel, premio gratuito y premio premium de cada nivel
- [ ] Cálculo de ritmo: con juego diario normal el nivel 40 se alcanza hacia la semana 5 — *F8 (2026-10-23) · decisión del usuario: F9-D2: ritmo de XP del pase (nivel 40 en la semana 5)*
- [ ] Premios de fin de temporada por división y para el top 100 — *F8 (2026-10-23) · decisión del usuario: F9-D2 + F9 T-33: premios por división y top 100; hoy por tramos de puesto, leídos `desc` (T-13) y reclamables en la bandeja única (T-17 bcfad56)*
- [x] Contrato escrito de missions_get, mission_claim, mission_reroll, achievements_get, achievement_claim, pass_get, pass_claim, pass_buy_premium
### 6.2 Servidor: motor de contadores
- [x] Definición por datos: evento, filtros (modo, pista, clase, posición máxima, tamaño) y meta
- [x] Evaluador que recibe RaceCompleted y devuelve qué contadores avanzan


---


- [x] Solo resultados no rechazados avanzan contadores — *F8 (2026-10-23) · hecha: ya se cumplía: un resultado rechazado (`INVALID_RESULT`) no entra a la sesión; abandonos y bots no cuentan (missions/event_bridge.ts); la ocultación por marcas va en F9 T-37*
- [ ] Soporte de contadores de valores distintos (por ejemplo, pistas diferentes) — *F8 (2026-10-23) · descarte propuesto: ninguna misión del catálogo cuenta valores distintos*
- [x] Pruebas unitarias del evaluador con cada tipo de filtro
### 6.3 Servidor: módulo missions
- [x] Catálogos missions_daily, missions_weekly y achievements
- [x] Objetos missions/daily y missions/weekly con sello de fecha, misiones asignadas y progreso
- [ ] Asignación perezosa: 3 misiones por semilla de jugador y fecha UTC al detectar cambio de día o de semana missions_get con misiones, progreso y tiempo restante mission_claim idempotente: paga monedas y XP de pase mission_reroll: un cambio gratuito por día Misiones bloqueadas hasta el nivel 3 — *F8 (2026-10-23) · 6.3.4 descarte propuesto: el cliente deriva el tiempo restante de `dateUtc`/`weekUtc` y `nowUtc`; 6.3.5 hecha: clave con el periodo y pago en un `moveWallet` (T-20 fcf1b22; humo 253ed39); 6.3.7 abierta: F9 T-35: `unlockLevel` solo marca `locked`; ni el reclamo ni el progreso lo aplican*
- [x] Logros con el mismo motor, sin vencimiento: achievements_get, achievement_claim
### 6.4 Servidor: módulo pass
- [ ] Catálogo pass_s{N} ligado a las fechas de la temporada — *F8 (2026-10-23) · decisión del usuario: F9-D1: un solo `pass_s1` (2026-01-05 → 2027-12-31) sin pase siguiente; la tabla ranked siguiente se crea sola*
- [x] Objeto pass/s{N}: XP de pase, niveles reclamados por carril, premium sí o no
- [x] XP de pase por misión reclamada y, en menor medida, por carrera terminada pass_get con nivel, progreso y estado de cada premio pass_claim por nivel y carril, idempotente pass_buy_premium con gemas; habilita reclamar los niveles premium ya alcanzados — *F8 (2026-10-23) · 6.4.5 hecha: reclamo y compra en un `moveWallet` con CAS correcto (T-19 8dcc649; humo 253ed39); 6.4.6 hecha: reclamo y compra en un `moveWallet` con CAS correcto (T-19 8dcc649; humo 253ed39)*
- [ ] Función de entrega de pase premium reutilizable para la compra con dinero real de la Fase 9 — *F8 (2026-10-23) · abierta: F9 T-39: función compartida de entrega del premium para IAP*
### 6.5 Servidor: cierre de temporada
- [ ] Detección perezosa de temporada vencida en el primer acceso del jugador — *F8 (2026-10-23) · abierta: F9 T-33: el pase cierra solo (T-19 8dcc649) pero ningún código crea la primera meta de temporada ranked, así que su cierre nunca corre*
- [ ] Lectura de división más alta y puesto final en ranked_s{N} — *F8 (2026-10-23) · decisión del usuario: F9-D2 + F9 T-33: premios por división y top 100; hoy por tramos de puesto, leídos `desc` (T-13) y reclamables en la bandeja única (T-17 bcfad56)*
- [ ] Premios de división y de top 100 enviados al inbox — *F8 (2026-10-23) · decisión del usuario: F9-D2 + F9 T-33: premios por división y top 100; hoy por tramos de puesto, leídos `desc` (T-13) y reclamables en la bandeja única (T-17 bcfad56)*
- [x] Premios de pase alcanzados y no reclamados enviados al inbox — *F8 (2026-10-23) · hecha: cierre del pase: premios alcanzados sin reclamar a la bandeja (T-19 8dcc649; humo 253ed39)*
- [ ] Creación de ranked/s{N+1} con reinicio parcial: 1000 + (rating − 1000) × 0,5 — *F8 (2026-10-23) · abierta: F9 T-33: reinicio parcial 1000 + (r − 1000) × 0,5 (hoy se arrastra)*
- [ ] Creación de la tabla ranked_s{N+1} y del pase de la nueva temporada — *F8 (2026-10-23) · decisión del usuario: F9-D1: un solo `pass_s1` (2026-01-05 → 2027-12-31) sin pase siguiente; la tabla ranked siguiente se crea sola*
- [ ] Marca de cierre procesado por jugador para que ocurra una sola vez — *F8 (2026-10-23) · abierta: F9 T-33: el cierre ranked es global (ids deterministas); sin marca por jugador ni test de doble cierre*


---


### 6.6 Cliente Unity
- [ ] Interfaces IMissionService, IAchievementService e IPassService con implementación Nakama
- [ ] Pantalla de misiones con pestañas diaria y semanal, barras de progreso y cuenta regresiva
- [ ] Botón de cambiar misión y botón de reclamar con animación de premio
- [ ] Progreso de misiones mostrado en la pantalla de resultados Pantalla de logros con progreso y reclamo
- [ ] Pantalla de pase: carril gratuito y premium, nivel actual, vista previa de premios Compra de pase premium con gemas
- [ ] Indicadores de premios por reclamar en el menú principal
- [ ] Pantalla de fin de temporada con división final y premios
### 6.7 Pruebas
- [x] Cambio de día UTC simulado: misiones nuevas y lo no reclamado se pierde
- [x] Dos jugadores distintos reciben misiones distintas el mismo día
- [x] Una misión solo avanza con carreras que cumplen su filtro Reclamar dos veces la misma misión paga una vez Reclamar un nivel de pase no alcanzado: rechazado
- [ ] Comprar premium en el nivel 12 permite reclamar los 12 premios premium — *F8 (2026-10-23) · abierta: F9 T-35: test de compra en el nivel 12 y reclamo de los 12 premium*
- [ ] Cierre de temporada adelantado en staging: premios en el inbox y temporada 2 abierta con rating reiniciado — *F8 (2026-10-23) · abierta: F9 T-33: el humo ya cierra un pase de simulacro (253ed39); falta el cierre ranked con reinicio*
- [ ] Cierre procesado dos veces para el mismo jugador: premia una vez — *F8 (2026-10-23) · abierta: F9 T-33: el cierre ranked es global (ids deterministas); sin marca por jugador ni test de doble cierre*
### 6.8 Criterio de terminado
- [x] Las misiones cambian solas con el día UTC y solo avanzan con carreras reales
- [x] Un jugador completa misiones, sube niveles de pase y reclama premios de ambos carriles
- [ ] La temporada 1 cierra y abre la 2 sin intervención manual — *F8 (2026-10-23) · abierta: F9 T-33: el pase cierra solo (T-19 8dcc649) pero ningún código crea la primera meta de temporada ranked, así que su cierre nunca corre*
- [x] Añadir una misión nueva requiere solo editar el catálogo
## Fase 7 — Social
Objetivo: que los jugadores se encuentren, corran juntos y pertenezcan a un club, con
chat moderado desde el primer día.


---


### 7.1 Diseño y contratos
- [ ] Reglas de club escritas: 30 miembros, costo de creación, roles, puntos por carrera (3 victoria, 2 podio, 1 terminar) Lista de frases rápidas para sala y carrera — *F8 (2026-10-23) · decisión del usuario: F9-D8: frases rápidas, listas de palabras bloqueadas y búsqueda por nombre*
- [ ] Lista de palabras bloqueadas por idioma (español, inglés, portugués) — *F8 (2026-10-23) · decisión del usuario: F9-D8: frases rápidas, listas de palabras bloqueadas y búsqueda por nombre*
- [x] Contrato escrito de friend_code_get, friend_add_by_code, recent_rivals_get, invite_send, club_create, club_get, club_update, club_search, report_player
### 7.2 Servidor: amigos y presencia
- [ ] Código de amigo corto por jugador y alta por código Búsqueda por nombre visible — *F8 (2026-10-23) · decisión del usuario: F9-D8: frases rápidas, listas de palabras bloqueadas y búsqueda por nombre*
- [ ] Suscripción a RaceCompleted: guarda los últimos 20 rivales humanos de cada jugador recent_rivals_get invite_send: notificación en tiempo real a un amigo con el código de grupo o de sala; persistente si está desconectado, con vencimiento Límite de invitaciones por minuto — *F8 (2026-10-23) · fuera de alcance: push y presencia en tiempo real: requisito futuro (P-03); las invitaciones persisten y se consultan con `invite_list`*
- [x] Bloqueo: un jugador bloqueado no puede invitar, escribir ni unirse a la sala del otro — *F8 (2026-10-23) · hecha: el bloqueo impide chatear, invitar y agregar por código (T-22 eb9e2c2; humo 8f5f4e3); unirse a la sala de carrera de un bloqueado: F9 T-36*
- [x] Vista de amigos de las leaderboards verificada con la lista real — *F8 (2026-10-23) · hecha: vista de amigos con la lista real (T-13 d813f2a)*
### 7.3 Servidor: clubes
- [ ] club_create: cobra monedas, valida nombre y lema con el filtro, crea el group con metadata (emblema, lema, región, división mínima) club_update solo para líder y administradores; la metadata nunca se escribe desde el cliente club_search por nombre, región y cupo disponible club_get con miembros, roles, aporte semanal de cada uno y puesto del club — *F8 (2026-10-23) · 7.3.2 hecha: fila de miembro `clubs_members/current/{userId}` creada con `*`: un club por jugador (T-21 c1005d1; humo 8f5f4e3); 7.3.3 abierta: F9 T-36: `club_search` usa `edgeCount` real (T-21) pero no filtra por plazas libres; 7.3.4 abierta: F9 T-36: `club_get` sin aporte semanal por miembro ni puesto (`weeklyRank: null`)*
- [x] Hook before de unirse al grupo: requisito de división mínima y nivel 8 — *F8 (2026-10-23) · hecha: `club_join` y `registerBeforeJoinGroup` con nivel 8, división y plazas (T-21 c1005d1; humo 8f5f4e3: `MIN_LEVEL`)*
- [x] Un jugador solo puede estar en un club; el club queda guardado en su perfil Tabla club_week con el group como dueño — *F8 (2026-10-23) · hecha: fila de miembro `clubs_members/current/{userId}` creada con `*`: un club por jugador (T-21 c1005d1; humo 8f5f4e3)*
- [x] Suscripción a RaceCompleted: suma puntos al club del jugador y a su aporte semanal — *F8 (2026-10-23) · hecha: el suscriptor y el reinicio semanal leen las filas reales de miembro (T-21 c1005d1); humo de unión y roster 8f5f4e3*
- [ ] Callback de reinicio semanal: premio al club ganador y extra a sus 3 mejores miembros por inbox Vista de club en lb_get — *F8 (2026-10-23) · 7.3.9 abierta: F9 T-36: el reinicio semanal solo corre al leer un club (perezoso), no en el ticker; 7.3.10 abierta: F9 T-36: `lb_get` sin vista de club*


---


### 7.4 Servidor: chat y moderación
- [x] Canal de club persistente con historial de 7 días Chat directo solo entre amigos mutuos — *F8 (2026-10-23) · hecha: canal de club con historial numerado y caducidad de 7 días (T-22 eb9e2c2); la recolección de lo caducado va en F9 T-41*
- [ ] Hook before de envío de mensaje: filtro de palabras, límite de 1 por segundo y 20 por minuto, longitud máxima — *F8 (2026-10-23) · abierta: F9 T-36: filtro y límites en `chat_send`; ningún hook rechaza unirse o escribir a un canal nativo*
- [ ] Rechazo de entrada a canales no permitidos (sin chat global) report_player con contexto: sesión, canal, últimos mensajes del reportado — *F8 (2026-10-23) · 7.4.4 abierta: F9 T-36: filtro y límites en `chat_send`; ningún hook rechaza unirse o escribir a un canal nativo; 7.4.5 abierta: F9 T-36: el contexto del reporte lo manda el cliente; el servidor no lee `chat_history`*
- [x] Silencio automático temporal con 3 reportes de jugadores distintos en 24 h
- [ ] RPC de soporte para ver reportes, silenciar, levantar silencio y sancionar — *F8 (2026-10-23) · abierta: F9 T-41: no hay RPC de baneo (`usersBanId`)*
- [x] Jugador silenciado: el hook rechaza sus mensajes y le informa hasta cuándo
### 7.5 Cliente Unity
- [ ] Interfaces IFriendService, IPartyService, IClubService, IChatService con implementación Nakama
- [ ] Lista de amigos con estado: desconectado, en menú, en cola, en carrera, en sala con cupo
- [ ] Publicación del estado propio al cambiar de pantalla
- [ ] Añadir por código, por búsqueda y desde rivales recientes o resultados
- [ ] Solicitudes entrantes, aceptar, rechazar, bloquear
- [ ] Invitar a grupo y a sala privada; aviso de invitación con aceptar y rechazar
- [ ] Grupo visible en el menú, con líder y cola conjunta Buscador y creación de club
- [ ] Pantalla de club: miembros, aportes, puesto semanal, gestión de roles y expulsión Chat de club y chat directo con historial
- [ ] Frases rápidas en sala y en carrera enviadas como código por el relay
- [ ] Botón de reportar y de bloquear en perfil, chat y resultados Ajuste para desactivar el chat de texto
### 7.6 Pruebas
- [ ] Dos amigos entran juntos a una cola desde una invitación y quedan en la misma carrera — *F8 (2026-10-23) · abierta: F9 T-34: humo de dos amigos en party → la misma sesión (el hook ya la crea, T-09 27c086c)*
- [x] Invitación a un jugador desconectado: la ve al conectarse si no venció Jugador bloqueado no puede invitar ni escribir Crear club sin monedas suficientes: rechazado — *F8 (2026-10-23) · hecha: el bloqueo impide chatear, invitar y agregar por código (T-22 eb9e2c2; humo 8f5f4e3); unirse a la sala de carrera de un bloqueado: F9 T-36*
- [x] Unirse a un club lleno o sin la división mínima: rechazado — *F8 (2026-10-23) · hecha: `club_join` y `registerBeforeJoinGroup` con nivel 8, división y plazas (T-21 c1005d1; humo 8f5f4e3: `MIN_LEVEL`)*
- [x] Una carrera suma puntos al club y al aporte del miembro — *F8 (2026-10-23) · hecha: el suscriptor y el reinicio semanal leen las filas reales de miembro (T-21 c1005d1); humo de unión y roster 8f5f4e3*


---


- [x] Reinicio semanal simulado: premio al club ganador en el inbox Mensaje con palabra bloqueada no se publica Más de 20 mensajes en un minuto: rechazados — *F8 (2026-10-23) · hecha: el suscriptor y el reinicio semanal leen las filas reales de miembro (T-21 c1005d1); humo de unión y roster 8f5f4e3*
- [x] Tres reportes de jugadores distintos silencian al reportado
### 7.7 Criterio de terminado
- [ ] Un jugador añade a un rival tras una carrera, lo invita y corren juntos — *F8 (2026-10-23) · abierta: F9 T-36: `recent_rivals_get` no permite agregar al rival sin su código*
- [x] Un club se crea, recibe miembros, suma puntos y aparece en su tabla semanal — *F8 (2026-10-23) · hecha: el suscriptor y el reinicio semanal leen las filas reales de miembro (T-21 c1005d1); humo de unión y roster 8f5f4e3*
- [ ] Todo canal de texto pasa por filtro, límite de frecuencia y reporte — *F8 (2026-10-23) · abierta: F9 T-36: filtro y límites en `chat_send`; ningún hook rechaza unirse o escribir a un canal nativo*
- [x] Los requisitos de las tiendas para chat (bloquear y reportar visibles) están cubiertos — *F8 (2026-10-23) · hecha: el bloqueo impide chatear, invitar y agregar por código (T-22 eb9e2c2; humo 8f5f4e3); unirse a la sala de carrera de un bloqueado: F9 T-36*
## Fase 8 — Torneos y eventos
Objetivo: ofrecer competencias con premio que abren y cierran solas, un calendario de
eventos manejado por configuración, y la telemetría necesaria para que esos premios no
se los lleven los tramposos.
### 8.1 Diseño y contratos
- [ ] Definición de los tres formatos: contrarreloj (mejor tiempo, 20 intentos), copa (puntos en 10 carreras), copa de clubes Tabla de puntos de copa para 2, 4 y 6 autos Premios por tramos de puesto de cada formato — *F8 (2026-10-23) · 8.1.1 decisión del usuario: F9-D3: copa y copa de clubes son etiquetas sin lógica (puntos por posición, tabla de clubes); 8.1.2 decisión del usuario: F9-D3: copa y copa de clubes son etiquetas sin lógica (puntos por posición, tabla de clubes)*
- [ ] Tipos de evento del calendario: XP doble, monedas extra, pista destacada, torneo, oferta especial — *F8 (2026-10-23) · abierta: F9 T-38: `xp_double` paga monedas aparte y no multiplica la XP (07 f12); no hay tipo «monedas extra»*
- [ ] Umbrales de la detección estadística escritos y revisables — *F8 (2026-10-23) · abierta: F9 T-37: umbrales de mejora brusca y quórum en constantes; sin rutina semanal escrita*
- [x] Contrato escrito de tournament_list, tournament_join, tournament_get, events_get — *F8 (2026-10-23) · hecha: contrato escrito de `event_list` (el checklist decía `events_get`) en unity-api.md y el OpenAPI (T-27 e2ce6f5)*
### 8.2 Servidor: módulo tournaments
- [ ] Catálogo tournaments con formato, pista, clase, fechas, costo de entrada, intentos y premios — *F8 (2026-10-23) · decisión del usuario: F9-D1: sin campo de clase y todas las ventanas de `tournaments.json` y `events.json` terminan antes del 2026-12-01*
- [ ] Creación de los torneos de Nakama desde el catálogo al arrancar tournament_list con activos y próximos, y el estado del jugador en cada uno tournament_join: nivel 10, cobro de entrada, inscripción — *F8 (2026-10-23) · 8.2.2 descarte propuesto: instancias propias en storage cerradas por el ticker (T-03 9e5aee3, T-23 0699c09) en lugar de torneos nativos de Nakama; 8.2.3 abierta: F9 T-38: `tournament_list` sin estado del jugador (inscrito, intentos, puesto)*
- [x] Contrarreloj: suscripción a RaceCompleted que escribe el mejor tiempo y descuenta un intento


---


- [ ] Copa: modo propio en el matchmaker y puntos por posición a la tabla del torneo — *F8 (2026-10-23) · decisión del usuario: F9-D3: copa y copa de clubes son etiquetas sin lógica (puntos por posición, tabla de clubes)*
- [ ] Copa de clubes: tabla con el club como dueño tournament_get con tabla, puesto del jugador, intentos restantes y premios — *F8 (2026-10-23) · 8.2.7 decisión del usuario: F9-D3: copa y copa de clubes son etiquetas sin lógica (puntos por posición, tabla de clubes); 8.2.8 hecha: `topTimes` real y `myRank` (T-23 0699c09; humo 8f5f4e3)*
- [x] Callback de fin de torneo: reparto de premios por tramos a través del inbox — *F8 (2026-10-23) · hecha: el ticker cierra una vez y paga a la bandeja reclamable (T-03 9e5aee3, T-23 0699c09; humo 8f5f4e3 con torneo de simulacro)*
- [ ] Retención de 24 h de los premios del top 10 y liberación manual o automática — *F8 (2026-10-23) · abierta: F9 T-38: sin retención de 24 h de los premios del top 10*
- [ ] Resultados marcados excluidos de la tabla del torneo — *F8 (2026-10-23) · abierta: F9 T-37: las marcas automáticas son siempre `low` y solo el suscriptor de torneos respeta la ocultación (07 f7)*
### 8.3 Servidor: calendario de eventos
- [ ] Lista de eventos en liveops/config con tipo, parámetros, inicio y fin — *F8 (2026-10-23) · abierta: F9 T-38: el calendario sale de `events.json` empaquetado (T-23 0699c09); editarlo exige build*
- [ ] Función activeEvents(ahora) usada por economía, tienda y matchmaking — *F8 (2026-10-23) · abierta: F9 T-34: `featured_track` no influye en la pista del matchmaker*
- [ ] Multiplicadores de XP y monedas aplicados durante el evento events_get para el cliente, con cuenta regresiva Notificación de inbox al iniciar un evento — *F8 (2026-10-23) · 8.3.3 abierta: F9 T-38: `xp_double` paga monedas aparte y no multiplica la XP (07 f12); no hay tipo «monedas extra»; 8.3.5 abierta: F9 T-38: sin aviso en la bandeja al empezar un evento*
### 8.4 Servidor: anti-trampas etapa 1
- [x] Parciales por checkpoint guardados con cada resultado — *F8 (2026-10-23) · hecha: parciales por vuelta en `race_partials` desde el suscriptor e historial de mejora brusca (T-23 0699c09); el informe no trae checkpoints*
- [x] Tiempo mínimo plausible por tramo entre checkpoints en el catálogo de pistas Detección de parcial imposible en un tramo — *F8 (2026-10-23) · hecha: parciales por vuelta en `race_partials` desde el suscriptor e historial de mejora brusca (T-23 0699c09); el informe no trae checkpoints*
- [x] Detección de mejora brusca frente al historial del jugador — *F8 (2026-10-23) · hecha: parciales por vuelta en `race_partials` desde el suscriptor e historial de mejora brusca (T-23 0699c09); el informe no trae checkpoints*
- [ ] Detección de desacuerdo de quórum repetido en un mismo jugador — *F8 (2026-10-23) · descarte propuesto: mismo motivo que 1.4.16: no existe el orden visto por cada cliente; queda el indicador de brecha de puesto*
- [ ] Objeto de marcas por jugador con historial y nivel de sanción — *F8 (2026-10-23) · abierta: F9 T-37: `anti_cheat_history` nunca se escribe; la sanción es solo `hiddenUntilUtc`*
- [ ] Marca oculta: los resultados del jugador dejan de entrar a tablas y torneos — *F8 (2026-10-23) · abierta: F9 T-37: las marcas automáticas son siempre `low` y solo el suscriptor de torneos respeta la ocultación (07 f7)*
- [ ] Mejor intento de contrarreloj guardado con parciales para revisión — *F8 (2026-10-23) · abierta: F9 T-37: la inscripción del torneo guarda `checkpoints: []`*
- [x] RPCs de soporte: listar marcados, ver parciales, confirmar, descartar, sancionar, liberar premios
- [ ] Panel de porcentaje de resultados rechazados y marcados por día — *F8 (2026-10-23) · abierta: F9 T-37: el panel no cuenta resultados rechazados ni porcentajes*
### 8.5 Cliente Unity
- [ ] Interfaces ITournamentService e IEventService con implementación Nakama
- [ ] Pantalla de eventos y torneos: activos, próximos, cuenta regresiva
- [ ] Detalle de torneo: reglas, premios, tabla, intentos restantes, botón de inscripción
- [ ] Entrada al contrarreloj de torneo y a la cola de copa desde el detalle
- [ ] Aviso de evento activo en el menú y en la pantalla de resultados Aviso de premios de torneo en el inbox
- [ ] Parciales por checkpoint incluidos en cada envío de resultado


---


### 8.6 Pruebas
- [x] Torneo de 1 hora en staging: abre, recibe intentos, cierra y reparte premios sin intervención Intento 21 en un contrarreloj: rechazado Inscripción sin monedas o sin nivel: rechazada — *F8 (2026-10-23) · hecha: el ticker cierra una vez y paga a la bandeja reclamable (T-03 9e5aee3, T-23 0699c09; humo 8f5f4e3 con torneo de simulacro)*
- [ ] Resultado con parcial imposible: marcado y fuera de la tabla — *F8 (2026-10-23) · abierta: F9 T-37: las marcas automáticas son siempre `low` y solo el suscriptor de torneos respeta la ocultación (07 f7)*
- [ ] Jugador con marca oculta: juega normal y no aparece en tablas Premio del top 10 retenido y luego liberado — *F8 (2026-10-23) · 8.6.5 abierta: F9 T-37: las marcas automáticas son siempre `low` y solo el suscriptor de torneos respeta la ocultación (07 f7); 8.6.6 abierta: F9 T-38: sin retención de 24 h de los premios del top 10*
- [ ] Evento de XP doble activado por configuración: se aplica sin build y termina solo — *F8 (2026-10-23) · abierta: F9 T-38: el calendario sale de `events.json` empaquetado (T-23 0699c09); editarlo exige build*
### 8.7 Criterio de terminado
- [x] Un torneo de fin de semana corre completo sin intervención manual — *F8 (2026-10-23) · hecha: el ticker cierra una vez y paga a la bandeja reclamable (T-03 9e5aee3, T-23 0699c09; humo 8f5f4e3 con torneo de simulacro)*
- [ ] Ningún resultado marcado cobra premio sin revisión — *F8 (2026-10-23) · abierta: F9 T-38: sin retención de 24 h de los premios del top 10*
- [ ] Programar un evento es editar la configuración remota — *F8 (2026-10-23) · abierta: F9 T-38: el calendario sale de `events.json` empaquetado (T-23 0699c09); editarlo exige build*
- [ ] Existe una rutina semanal de revisión de marcados con sus herramientas — *F8 (2026-10-23) · abierta: F9 T-37: umbrales de mejora brusca y quórum en constantes; sin rutina semanal escrita*
## Fase 9 — Compras reales y anuncios
Objetivo: vender con dinero real en móvil y PC (paquetes de monedas y gemas, skins y
recolores, autos, personalizaciones, pase de temporada, paquetes de evento y
especiales), con cada compra validada por el servidor y entregada una sola vez.
Si se quiere medir ingresos durante el lanzamiento en pruebas, esta fase puede
adelantarse a justo después de la Fase 5: solo depende de las fases 3 y 5.
### 9.1 Diseño y contratos
- [ ] Tienda de PC elegida y su sistema de compras revisado — *F8 (2026-10-23) · fuera de alcance: PC/Steam con compras fuera de alcance (plan §1)*
- [ ] Lista de productos con precio por tienda: paquetes de gemas, paquetes de monedas, paquete inicial, paquetes de skins, autos, pase premium, paquetes de evento — *F8 (2026-10-23) · decisión del usuario: F9-D6: precios por tienda, qué se compra con dinero o con gemas, paquetes de gemas y reglas entre plataformas*
- [ ] Regla definida: qué se compra directo con dinero y qué solo con gemas — *F8 (2026-10-23) · decisión del usuario: F9-D6: precios por tienda, qué se compra con dinero o con gemas, paquetes de gemas y reglas entre plataformas*
- [ ] Catálogo iap_products: ID de producto por tienda, contenido como lista de Reward, límite de compras, vigencia — *F8 (2026-10-23) · abierta: F9 T-39: `iap_packs.json` sin límite de compras ni vigencia*
- [ ] Contrato escrito de iap_products_get, iap_validate, iap_restore — *F8 (2026-10-23) · abierta: F9 T-39: no hay `iap_products_get` (el cliente fija los ids); `iap_purchase` sustituye a `iap_validate`*
- [ ] Revisión de las reglas de cada plataforma sobre moneda comprada en otra plataforma — *F8 (2026-10-23) · decisión del usuario: F9-D6: precios por tienda, qué se compra con dinero o con gemas, paquetes de gemas y reglas entre plataformas*


---


### 9.2 Configuración de tiendas
- [ ] Productos creados en App Store Connect y en Google Play Console con los mismos identificadores lógicos Productos creados en la tienda de PC — *F8 (2026-10-23) · 9.2.1 pendiente del usuario: productos, credenciales y cuentas sandbox de las tiendas (las variables ya existen en `.env`, T-24 11bbd6c); 9.2.2 fuera de alcance: PC/Steam con compras fuera de alcance (plan §1)*
- [ ] Credenciales de validación de Apple y Google cargadas en la configuración de Nakama — *F8 (2026-10-23) · pendiente del usuario: productos, credenciales y cuentas sandbox de las tiendas (las variables ya existen en `.env`, T-24 11bbd6c)*
- [ ] Notificaciones de servidor de Apple y de Google apuntando al servidor para reembolsos Cuentas de prueba de compra en cada tienda — *F8 (2026-10-23) · 9.2.4 abierta: F9 T-40: sin notificaciones de servidor de Apple/Google; el reembolso es manual (`admin_iap_refund`) y solo de monedas; 9.2.5 pendiente del usuario: productos, credenciales y cuentas sandbox de las tiendas (las variables ya existen en `.env`, T-24 11bbd6c)*
### 9.3 Servidor: compras
- [ ] iap_products_get: productos visibles para el jugador según plataforma, eventos y límites iap_validate para Apple con la validación nativa de Nakama iap_validate para Google con la validación nativa de Nakama — *F8 (2026-10-23) · 9.3.1 abierta: F9 T-39: no hay `iap_products_get` (el cliente fija los ids); `iap_purchase` sustituye a `iap_validate`; 9.3.2 hecha: verificación real alcanzable, mock solo con `IAP_MOCK`, una entrega (T-24 11bbd6c; humo 0546887); falta comprobar `bundle_id` (F9 T-40) y la prueba sandbox (humana); 9.3.3 hecha: verificación real alcanzable, mock solo con `IAP_MOCK`, una entrega (T-24 11bbd6c; humo 0546887); falta comprobar `bundle_id` (F9 T-40) y la prueba sandbox (humana)*
- [ ] Validación de compras de PC contra la API de la tienda elegida (integración propia) — *F8 (2026-10-23) · fuera de alcance: PC/Steam con compras fuera de alcance (plan §1)*
- [x] Entrega del contenido con el ID de transacción como clave de idempotencia
- [x] Recibo ya visto: responde éxito sin entregar de nuevo
- [ ] Plataforma de origen registrada en cada entrega de gemas — *F8 (2026-10-23) · decisión del usuario: F9-D6: precios por tienda, qué se compra con dinero o con gemas, paquetes de gemas y reglas entre plataformas*
- [ ] Productos no consumibles (autos, skins, pase): iap_restore los reentrega si faltan Límite de compras por producto y por jugador — *F8 (2026-10-23) · 9.3.8 abierta: F9 T-39: no hay `iap_restore`; 9.3.9 abierta: F9 T-39: `iap_packs.json` sin límite de compras ni vigencia*
- [ ] Pase premium comprable con dinero usando la función de entrega de la Fase 6 — *F8 (2026-10-23) · abierta: F9 T-39: pase premium con dinero (necesita el producto en las tiendas, F9-D6)*
- [ ] Paquetes de evento ligados al calendario de la Fase 8 — *F8 (2026-10-23) · abierta: F9 T-39: `iap_purchase` no consulta el calendario (los `special_offer` actuales apuntan a SKUs inexistentes, F9-D1)*
- [ ] Reembolso notificado: descuenta lo entregado; saldo negativo marca la cuenta — *F8 (2026-10-23) · abierta: F9 T-40: sin notificaciones de servidor de Apple/Google; el reembolso es manual (`admin_iap_refund`) y solo de monedas*
- [ ] Eventos de analítica: compra iniciada, validada, entregada, fallida, reembolsada, con precio y moneda — *F8 (2026-10-23) · abierta: F9 T-40: analítica sin precio ni moneda; los ingresos son una suma de monedas*
- [ ] RPC de soporte para consultar las compras de un jugador y reentregar una compra — *F8 (2026-10-23) · abierta: F9 T-41: no hay RPC para reentregar una compra*
### 9.4 Servidor: anuncios con recompensa
- [ ] Lugares de anuncio definidos en el catálogo con premio y tope diario — *F8 (2026-10-23) · abierta: F9 T-39: sin lugares de anuncio en el catálogo; el tope diario (10) es una constante global*
- [x] Punto de entrada para la verificación de servidor a servidor de la red de anuncios, con validación de firma — *F8 (2026-10-23) · hecha: callback S2S firmado de LevelPlay, pago una vez por evento; `ad_watched` no paga (T-25 4609b3e; humo 0546887)*
- [ ] Entrega del premio solo al recibir la verificación, con el ID de la impresión como clave de idempotencia Tope diario por jugador y por lugar — *F8 (2026-10-23) · 9.4.3 hecha: callback S2S firmado de LevelPlay, pago una vez por evento; `ad_watched` no paga (T-25 4609b3e; humo 0546887); 9.4.4 abierta: F9 T-39: sin lugares de anuncio en el catálogo; el tope diario (10) es una constante global*


---


### 9.5 Cliente Unity
- [ ] Interfaz IPurchaseService sobre el servicio de compras existente, con implementación por tienda
- [ ] Tienda de dinero real: productos con precio local traído de la tienda
- [ ] Flujo: comprar en la tienda, enviar recibo a iap_validate, confirmar la compra a la tienda solo tras la respuesta del servidor Compras pendientes reenviadas al iniciar el juego Botón de restaurar compras Pantalla de entrega con el contenido recibido Mensajes de compra cancelada, pendiente y fallida
- [ ] Oferta de paquete inicial y de paquetes de evento en el menú
- [ ] Anuncio con recompensa: mostrar, esperar la entrega del servidor, actualizar saldos
- [ ] Compras desactivables por configuración remota y por plataforma
### 9.6 Anti-trampas etapa 2 (solo si el ranked lo necesita)
- [ ] Handler de match autoritativo delgado que reenvía todos los mensajes sin interpretarlos — *F8 (2026-10-23) · decisión del usuario: F9-D4: match autoritativo que interpreta checkpoint y meta (hoy relay puro, D13)*
- [ ] Interpretación de dos códigos de operación: cruce de checkpoint y meta — *F8 (2026-10-23) · decisión del usuario: F9-D4: match autoritativo que interpreta checkpoint y meta (hoy relay puro, D13)*
- [ ] Orden de llegada y tiempos sellados con el reloj del servidor; resultado con confianza server — *F8 (2026-10-23) · decisión del usuario: F9-D4: match autoritativo que interpreta checkpoint y meta (hoy relay puro, D13)*
- [ ] El hook matchmakerMatched crea el match autoritativo para ranked y torneos Prueba de carga repetida con el handler activo — *F8 (2026-10-23) · 9.6.4 decisión del usuario: F9-D4: match autoritativo que interpreta checkpoint y meta (hoy relay puro, D13); 9.6.5 decisión del usuario: F9-D4: match autoritativo que interpreta checkpoint y meta (hoy relay puro, D13)*

> **Nota**: Phase 9.6 fue **diferida** (deferred). El ranked en producción no la necesitó durante el desarrollo. La detección de trampas de Phase 8 (anti-cheat subscriber + admin RPCs) cubre los casos observados. Se reactiva si aparecen nuevos vectores.
### 9.7 Pruebas
- [ ] Compra de prueba en Apple, Google y PC: contenido entregado una vez — *F8 (2026-10-23) · pendiente del usuario: productos, credenciales y cuentas sandbox de las tiendas (las variables ya existen en `.env`, T-24 11bbd6c)*
- [x] El mismo recibo enviado dos veces: una sola entrega Recibo falso o de otra aplicación: rechazado — *F8 (2026-10-23) · hecha: recibos inventados de Apple/Google/mock rechazados con el mock apagado (T-24 11bbd6c; humo 0546887); `bundle_id` en F9 T-40*
- [x] Juego cerrado entre el pago y la validación: la compra se entrega al volver a abrir — *F8 (2026-10-23) · hecha: mitad servidor: reintento idempotente también tras reinicio (T-24 11bbd6c; humo 0546887); la transacción pendiente al reabrir es del cliente*
- [ ] Restaurar compras en un dispositivo nuevo devuelve autos, skins y pase Reembolso de prueba: gemas descontadas Compra en móvil visible en PC con la misma cuenta Anuncio sin verificación del servidor: sin premio — *F8 (2026-10-23) · 9.7.5 abierta: F9 T-39: no hay `iap_restore`; 9.7.6 abierta: F9 T-40: sin notificaciones de servidor de Apple/Google; el reembolso es manual (`admin_iap_refund`) y solo de monedas; 9.7.7 fuera de alcance: PC/Steam con compras fuera de alcance (plan §1); 9.7.8 hecha: callback S2S firmado de LevelPlay, pago una vez por evento; `ad_watched` no paga (T-25 4609b3e; humo 0546887)*
- [x] Tope diario de anuncios alcanzado: el botón se desactiva


---


### 9.8 Criterio de terminado

| 9.8 Criterio de terminado Cada tipo de producto se puede comprar en móvil y en PC y llega a la misma cuenta Ninguna compra se entrega sin validación del servidor ni más de una vez Los reembolsos se reflejan en la cuenta Los ingresos por producto y plataforma se ven en la analítica |
| --- |

## Fase 9 (servidor) — COMPLETO

✅ **8/8 chunks shipped** (ad64c7e..7e41074). 2401 tests verde (+335). 4 public + 16 admin RPCs. 11 IAP + 4 ads events. 8 storage collections. 4 new docs. D61-D93.

- MOCK provider only (D76); real AdMob/Unity Ads deferred
- Refund 90d cap (D86)
- All money flows BYPASS maintenance (D63, D72, D77, D79, D91)
- Top buyers admin-only privacy (D92)

Cliente Unity §9.5 queda [ ] (no scope servidor).


---

# ACTUALIZACIÓN DE ESTADO — 2026-10-09

Estado del trabajo servidor (Phases 1–9 completas; Fase 9 wrap Chunk 8 cerrado).

## Resumen por fase

| Fase | Estado servidor | Tests | Chunks | Decisiones | Notas |
| --- | --- | --- | --- | --- | --- |
| 1. Sesión de carrera | ✅ Completo | — | 15 | D1–D∞ | Capa base; RaceCompleted event bus |
| 2. Leaderboards + perfil | ✅ Completo | — | 15 | D1–D∞ | 3 vistas (global/alrededor/amigos) |
| 3. Economía + garage + progresión | ✅ Completo | 378 | 10 | D1–D∞ | 8 RPCs; D3 compensating-refund |
| 4. Matchmaking + ranked | ✅ Completo | 688 | 10 | D1–D12 | 4 RPCs + matchmakerMatched hook |
| 5. Operación + lanzamiento | ✅ Completo | 873 | 10 | D1–D13 (D7 amended) | 12 RPCs; adminRpcKey, region relay |
| 6. Misiones + pase + temporada | ✅ Completo | 1239 | 8 | D1–D13 | 9 RPCs; cierre temporada con inbox |
| 7. Social | ✅ Completo | 1686 | 9 | D1–D18 | 26 RPCs; 4 gaps 3.27 JS runtime |
| 8. Torneos + eventos + anti-cheat | ✅ Completo | 2066 | 10 | D19–D60 | 18 RPCs (4 user + 14 admin) |
| 9. Compras + anuncios | ✅ Completo | 2401 | 8 | D61–D93 | 11 IAP + 4 ads RPCs (4 user + 7 admin + 4 analytics) |

**Total**: 2401 tests verde, 90 RPCs, 93+ decisiones locked, 9 fases servidor completas.

## Decisiones locked a nivel proyecto

- **D3 (compensating-refund)**: Nakama 3.27 JS runtime no soporta wallet ops dentro de `multiUpdate` — patrón spend-first + CAS-write + grant-refund-on-conflict
- **D7 amended**: `adminRpcKey` en `LiveopsConfig` (capa JS no ve query param `http_key`)
- **D49**: `BAD_REQUEST` (no `INVALID_ARGUMENT`) para validación de argumentos
- **D54**: `activeSpecialOffers` cap 10 ordenado por `endsAt` asc
- **D60**: `admin_anti_cheat_dashboard_get` = live snapshot; `admin_anti_cheat_stats_get` = date-range

## 4 gaps documentados (Nakama 3.27 JS runtime)

1. `nk.socketSend`/presence NO en JS runtime → events usan `delivered:'offline'`
2. `registerBeforeAddGroupUsers` NO en JS runtime → skip
3. `registerLeaderboardReset` NO en JS runtime → skip
4. `registerBeforeSendChannelMessage` NO en JS runtime → skip

## KNOWN GAPS deferred

- **Economy gap E** (Phase 3 spreadsheet): casual 1h/día = 8–9 días al primer auto. Fix +75% rewards + login bonus +500/día. **NO aplicar durante Phase 4** (distorsiona métricas ranked/matchmaking). Pendiente decisión usuario.
- **Ranked close-on-grace**: ruta de cierre al vencer gracia NO implementada (Phase 4 KNOWN GAP)
- **Real socket push**: diferido (gap 3.27)

## 5 mission_progress.test.ts failures — FIXED

- Root cause: tests sembraban `seedDailyWith(env, USER_A, [...], '2026-10-07')` (fecha hardcoded) mientras `fireRace` usaba `Date.now()`. Subscriber computaba `utcDate(raceEvent.closedAt)` = hoy, leía storage key distinto al seed, no encontraba row → no tick.
- Fix: reemplazar '2026-10-07' hardcoded por `utcDateStr(ts)` para que seed y race compartan misma fecha UTC.
- Resuelto en Phase 8 Chunk 10 (deca1ce).

## Pendiente cliente Unity (NO tocado por servidor)

- Phase 1.5: IConfigService/IRaceSessionService/IServerClock, sala privada, autos desde sesión, mensajes checkpoint/meta
- Phase 2.4: ILeaderboardService/IProfileService, leaderboards UI, formato tiempo mm:ss.mmm
- Phase 3.5: IEconomyService/IGarageService/IStoreService, garage/upgrade/personalización UI
- Phase 4.5: IMatchmakingService/IRankedService, cola UI, autodrive, migración de host
- Phase 5.5: selector de entorno, doble conexión, ajustes de cuenta, mantenimiento/inbox
- Phase 6.6: IMissionService/IPassService, misiones/pase UI
- Phase 7.5: IFriendService/IPartyService/IClubService/IChatService, club/chat UI
- Phase 8.5: ITournamentService/IEventService, torneos/eventos UI, parciales
- Phase 9.5: IPurchaseService, tienda dinero real, flujos compra/anuncio

## Decisión de cliente Unity

El servidor entrega los siguientes contratos que el cliente debe consumir:

- **docs/unity-api.md** §1–§21: contratos de RPC, errores, integración
- **docs/liveops.md**: maintenance gate, min client version
- **docs/matchmaking.md** + **docs/ranked.md**: ticket properties, size rules, seasons
- **docs/account-linking.md** + **docs/admin.md**: account lifecycle + admin RPCs
- **docs/tournaments.md** + **docs/events.md** + **docs/anti-cheat.md**: Phase 8

## Memoria del proyecto (referencia)

- `memory/carvideogamebackend-phase1-complete.md` … `phase8-complete.md` — una por fase
- `memory/MEMORY.md` — índice de memories
- `memory/multi-agent-coordination.md` — protocolo coordinador + implementador
- `memory/token-discipline-protocol.md` — `/compact` post-push, specs ≤2k
- `memory/credit-pause-protocol.md` — cron coordinador pings implementador cuando credits restore

## Siguiente fase

**Phase 9 — Compras reales y anuncios** (en curso):
- Chunk 1 (enviado): catalog IAP packs + ad rewards + types + boot
- Chunk 2: receipt verification (Apple/Google)
- Chunk 3: `iap_purchase` RPC + idempotencia
- Chunk 4: subscriptions lifecycle
- Chunk 5: ad rewards system
- Chunk 6: admin IAP RPCs
- Chunk 7: analytics
- Chunk 8: WRAP (e2e + docs/iap.md + docs/ads.md + unity-api §22 + README)




