# BálnaSkip – Súlytalan reklámskip

Firefox/Waterfox kiegészítő, amely a **Súlytalan** csatorna videóinak elején felismeri a
„Bálna, te súlytalan …” trigger mondatot, majd **5,5 másodperccel előreugrik**.

A kiegészítő csak a `https://www.youtube.com/@sulytalanbalna` csatorna videóin aktív.

**Letöltés:** [a legfrissebb kiadás a Releases oldalon](https://github.com/Nandor116/balnaskip/releases/latest).

## Mit tud?

- A videó első **5 percében** keresi a trigger mondatot a magyar feliratban.
- Tolerálja az automatikus beszédfelismerés tipikus hibáit: `Bálla`, `Bál`, `Bála`, `sújtalan`.
- A trigger után **5,5 mp**-es ugrás, a videó aktuális pozíciójából.
- **Visszavonás** a képernyőn megjelenő toastból vagy a popupból.
- Ha visszatekérsz a trigger elé, a figyelés **újra aktiválódik**.
- Kezeli a YouTube SPA-navigációját, a reklám alatti időszakot és az újraindított videóelemet.
- Nem módosítja a YouTube felületét, és nem gyűjt adatot.

## Telepítés

1. Töltsd le a legfrissebb `.xpi` fájlt a repository **Releases** oldaláról.
2. Ha a böngésző kéri, engedélyezd az aláíratlan kiegészítőket:
   - `about:config`
   - keresd meg: `xpinstall.signatures.required`
   - állítsd `false`-ra.
3. Nyisd meg az `about:addons` oldalt.
4. Kattints a fogaskerék ikonra → **Install Add-on From File…** (Kiegészítő telepítése fájlból).
5. Válaszd ki a letöltött `.xpi` fájlt.

### Kitűzés a toolbarra

- Jobb klikk a BálnaSkip ikonjára → **Pin to Toolbar** / **Rögzítés az eszköztárhoz**.
- Vagy: jobb klikk a toolbarra → **Customize Toolbar…**, és húzd az ikont a kívánt helyre.

### Fontos az aláíratlan XPI-ről

A kiadott XPI jelenleg **nincs Mozilla által aláírva**. Waterfox, Firefox Developer Edition
és Nightly alatt az `xpinstall.signatures.required = false` beállítás általában elég.
Firefox Release alatt a Mozilla aláírás hiányában a rendszeres telepítés tiltott lehet;
ilyenkor az `about:debugging#/runtime/this-firefox` oldalon lehet ideiglenesen betölteni,
vagy a kiegészítőt előbb aláírásra kell küldeni az addons.mozilla.org felületén.

## Használat

1. Nyiss meg egy videót a Súlytalan csatornáról.
2. A popup állapota mutatja, hogy éppen figyel-e:
   - **Figyelem a trigger mondatot** – megtalálta a triggeret, várja a pillanatot.
   - **Reklám átugorva** – megtörtént az ugrás; itt jelenik meg a **Vissza a reklámhoz** gomb.
   - **Nem a Súlytalan csatorna** – ezen a videón nem aktív.
   - **Nincs magyar felirat** – a trigger felismeréséhez magyar felirat kell.
3. Ugrás után a képernyő alján megjelenő toaston is van **Visszavonás** gomb.
4. Ha a reklámot mégis látni szeretnéd, kattints a visszavonásra, vagy tekerj vissza a
   trigger elé; ekkor a kiegészítő újra figyelni kezd.
5. A popup **Automatikus ugrás** kapcsolójával az egész funkció kikapcsolható.

## Hogyan működik?

A kiegészítő a YouTube magyar feliratát olvassa ki a videó oldaláról:

- elsődleges forrás: a `timedtext` felirat;
- tartalék: a YouTube „Átirat” panelje (`youtubei/v1/get_panel`).

A felirat kérését a content script végzi ugyanarról a YouTube-originről, mert a
kiegészítő saját originjéről a YouTube `403`-at ad. A háttérlap csak a beállítások
inicializálásáért felel; a felismerés, az ugrás és a visszavonás állapota a content
scriptben marad, így a popup bezárása nem szakítja meg a működést.

## Korlátok

- Magyar felirat (vagy átirat) nélkül nem tudja felismerni a triggeret.
- Ha a YouTube PO-token védelmet kér, vagy üres feliratot ad, a kiegészítő hibát jelez.
- Nem általános reklámblokkoló: kizárólag a konkrét trigger mondatra reagál.
- A trigger csak az első 5 percben keresendő; későbbi előfordulásokat nem kezel.
- Ha a videó a trigger után indul, az ugrás kimarad („A trigger már elhangzott”).
- A skip hossza fix **5,5 mp**; hosszabb reklám esetén a visszatekeréssel lehet újra
  aktiválni a figyelést.

## Kompatibilitás

- Waterfox 153.5.0 és 153.6.0 alatt tesztelve.
- Firefox 157.0.1 alatt tesztelve.
- uBlock Origin és SponsorBlock mellett is működik. A SponsorBlock ugyanazt a
  szegmenst a saját adatbázisából szintén átugorhatja; a két kiegészítő nem ütközik,
  legfeljebb a SponsorBlock még tovább teker a szegmens végére.

## Ikon

Az ikon a **Súlytalan** csatorna profilképe, a skip jelet tartalmazó jelöléssel.
A profilképre vonatkozó jogok a csatornát illetik.

## Fejlesztés

```powershell
# Egységtesztek
node tests/core.test.js

# XPI újraépítése (a manifest verziószámából nevezi el a fájlt)
python tools/build_xpi.py
```

A forrás a `extension/` mappában van, a kész csomag a `dist/` mappába kerül. A `dist/`
nincs verziókövetve; a kiadott XPI a Releases oldalon érhető el.

## Adatvédelem

A kiegészítő nem küld adatot külső szerverre, nem használ analitikát, és nem tárol
személyes adatot. A beállítás (`enabled`) a böngésző helyi tárhelyén marad.

## Verzió

- **1.1.0** – a skip hossza 5 mp-ről 5,5 mp-re nőtt; a popup és a toast szövege frissült.
- **1.0.0** – első kiadás.
