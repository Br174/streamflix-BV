# Verlezza Vision TV — Downloader e aggiornamenti

Codice stabile da usare su Downloader: **3875230**.

Destinazione registrata su AFTVnews:
https://github.com/Br174/streamflix-BV/releases/latest/download/Visionflix_BV_TV.apk

Il nome dell'asset pubblico resta intenzionalmente `Visionflix_BV_TV.apk`: in questo modo il codice Downloader non cambia anche se il nome visibile dell'app è **Verlezza Vision**.

Il precedente codice **6847755** resta collegato alla vecchia build 28 e non va usato per le versioni future.

## Automatismo

Il progetto privato `Br174/Visionflix` compila automaticamente Mobile e TV a ogni push su `main`.

Per la TV il workflow:

1. aumenta automaticamente `versionCode` e `versionName` in CI;
2. usa la chiave debug stabile già conservata dal workflow;
3. compila l'APK TV con application ID `com.br174.visionflix.tv.debug`;
4. verifica firma, package, entry point TV e versionCode;
5. salva gli APK come artifact GitHub Actions;
6. aggiorna anche la release privata `tv-latest` del progetto sorgente;
7. se è configurato il secret `PUBLISH_TOKEN`, pubblica automaticamente una nuova release **Latest** nel repository pubblico `Br174/streamflix-BV`, allegando l'APK con il nome fisso `Visionflix_BV_TV.apk`.

Quando il punto 7 è attivo, il codice **3875230** segue sempre l'ultima APK TV pubblicata: non serve creare un nuovo codice Downloader ad ogni versione.

## Autorizzazione una tantum

Nel repository privato `Br174/Visionflix` deve esistere un Actions secret chiamato `PUBLISH_TOKEN`. Deve contenere un fine-grained GitHub token autorizzato sul solo repository `Br174/streamflix-BV` con permesso **Contents: Read and write**.

Il token non va scritto nei sorgenti, nei log o in chat.

## Regole da non cambiare

- mantenere il link `releases/latest/download/Visionflix_BV_TV.apk`;
- mantenere il nome asset `Visionflix_BV_TV.apk`;
- mantenere l'application ID TV `com.br174.visionflix.tv.debug`;
- mantenere la stessa firma per gli aggiornamenti della stessa app;
- usare sempre il codice Downloader **3875230**.
