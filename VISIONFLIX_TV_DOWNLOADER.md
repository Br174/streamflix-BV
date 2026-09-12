# Visionflix BV TV — Downloader e aggiornamenti

Codice da usare per le prossime installazioni e gli aggiornamenti: **3875230**.

Destinazione registrata su AFTVnews:
https://github.com/Br174/streamflix-BV/releases/latest/download/Visionflix_BV_TV.apk

Il codice segue l'APK della release pubblica indicata come Latest su questo repository. L'aggiornamento sulla TV avviene scaricando e installando nuovamente l'APK con Downloader; non è un aggiornamento automatico in background.

Il precedente codice **6847755** resta collegato alla release `bv-tv-build28` e non va indicato per le versioni future.

## Procedura per le prossime consegne

1. Compilare la nuova versione TV dal progetto Visionflix e controllare il risultato della compilazione.
2. Mantenere l'application ID `com.br174.visionflix.tv.debug` e la chiave di firma esistente per consentire l'aggiornamento dell'app installata. Aumentare il versionCode rispetto all'ultima versione distribuita (build 28: 160).
3. Verificare l'APK con apksigner, controllare il punto di avvio TV e calcolarne SHA-256.
4. Pubblicare una nuova release pubblica con il file chiamato esattamente `Visionflix_BV_TV.apk`. Allegare i controlli e contrassegnare la release come Latest solo quando l'APK verificato è presente.
5. Verificare che il link stabile scarichi senza autenticazione il nuovo APK e che la sua SHA-256 coincida con quella attesa.
6. Consegnare sempre il codice **3875230**. Non creare un nuovo codice per ogni build e non rinominare l'asset.

Le sole modifiche ai sorgenti in Work o una compilazione privata su GitHub Actions non aggiornano il file pubblico. Anche la pubblicazione deve essere completata.

Il workflow `.github/workflows/publish-visionflix-tv.yml` attuale è vincolato all'archivio, al checksum, al tag e alle note della build 28: per distribuire un nuovo APK occorre aggiornare questi dati. Eseguirlo senza aggiornamenti conserva la build 28. La sua pubblicazione usa già il nome file stabile e `--latest`.

Non indicare come Latest una release di un'altra app che non contenga `Visionflix_BV_TV.apk`.

## Verifica iniziale del collegamento stabile — 12 settembre 2026

- Versione disponibile: 1.7.231, build 28.
- APK: 39.819.592 byte.
- SHA-256 APK: `9ebe46cb8f012b38442571b5866b5b7c1e0568cb25ff9838a22af6f56ceda970`.
- SHA-256 certificato di firma: `1cd369d6b3d6f3bb97be87a27b4a29748c533d36106a2d4ff60a67f477bbe110`.
- Link Latest verificato con download anonimo e confronto SHA-256.
- Codice 3875230 generato dal servizio AFTVnews e associato al link Latest sopra riportato.

Il progetto sorgente Visionflix resta privato; qui vengono distribuiti gli installer.
