import express from 'express';
import cors from 'cors';
import fs from 'fs';
const path = require('path');
const readline = require('readline');
const AdmZip = require('adm-zip');

// Globální on-demand indexy (zabírají minimum RAM, jelikož drží jen stringy)
let vdvStopsMap = new Map();      // stop_id -> [lon, lat]
let vdvTripIdMap = new Map();     // "841129_25" -> trip_id
let isVdvIndexing = false;
let isVdvReady = false;

const app = express();
app.use(cors());

let jmkStops = {};
let pidTrips = {};
let pidTripsShort = {};

const manualStops = {
    "15244": "Blučina, CTP",
    "20220": "Brodek u Prostějova",
    "20221": "Hradčany-Kobeřice, Kobeřice",
    "20223": "Dobrochov, pohostinství",
    "20222": "Dobrochov",
    "20224": "Vranovice-Kelčice, Kelčice, pod mostem",
    "20225": "Dětkovice",
    "20226": "Prostějov, Brněnská",
    "20227": "Prostějov, Újezd",
    "30013": "Prostějov, aut.st.",
    "7510": "Nová Zbrojovka",
    "20201": "Malé Hradisko",
    "20202": "Ptení, Holubice, rozcestí",
    "20203": "Stínava",
    "20204": "Vícov",
    "20206": "Plumlov, Hamry",
    "20207": "Plumlov, Žárovice",
    "20208": "Plumlov, Soběsuky",
    "20209": "Plumlov",
    "20210": "Plumlov, přehrada",
    "20211": "Mostkovice, kino",
    "20212": "Mostkovice, pomník",
    "20213": "Prostějov, Krasice, rozcestí",
    "20214": "Prostějov, nemocnice",
    "20215": "Prostějov, Floriánské náměstí",
    "20217": "Prostějov, Svatoplukova DONA"
};

try {
    if (fs.existsSync('./data/jmk_stops.json')) {
        jmkStops = JSON.parse(fs.readFileSync('./data/jmk_stops.json', 'utf8'));
    }
    if (fs.existsSync('./data/pid_cisjr.json')) {
        pidTrips = JSON.parse(fs.readFileSync('./data/pid_cisjr.json', 'utf8'));
        
        // Vytvoříme záložní slovník (odsekne datum, z 226_44_240926 udělá jen 226_44)
        for (const [key, val] of Object.entries(pidTrips)) {
            const parts = key.split('_');
            if (parts.length >= 2) {
                pidTripsShort[`${parts[0]}_${parts[1]}`] = val;
            }
        }
    }
    console.log(`Data úspěšně načtena z disku. (JMK: ${Object.keys(jmkStops).length}, PID přesný: ${Object.keys(pidTrips).length}, PID zkrácený: ${Object.keys(pidTripsShort).length})`);
} catch (e) {
    console.warn("Upozornění: JSON data zatím neexistují. Github Action je vytvoří v noci.");
}

let vdvStopsCoords = {};
try {
    if (fs.existsSync('./data/vdv_stops_coords.json')) {
        vdvStopsCoords = JSON.parse(fs.readFileSync('./data/vdv_stops_coords.json', 'utf8'));
        console.log(`VDV souřadnice tras načteny (${Object.keys(vdvStopsCoords).length} spojů).`);
    }
} catch (e) {
    console.warn("Upozornění: Soubor vdv_stops_coords.json neexistuje.");
}

// --- 1. ENDPOINT PRO HLAVNÍ DATA ---
app.get('/grapp', async (req, res) => {
    try {
        const initResponse = await fetch('https://grapp.spravazeleznic.cz/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            }
        });

        if (!initResponse.ok) throw new Error(`Chyba: ${initResponse.status}`);
        const initHtml = await initResponse.text();

        let sessionId = '';
        if (initResponse.headers.getSetCookie) {
            for (const cookie of initResponse.headers.getSetCookie()) {
                if (cookie.includes('ASP.NET_SessionId')) sessionId = cookie.split(';')[0].split('=')[1];
            }
        }
        if (!sessionId) {
            const setCookieHeader = initResponse.headers.get('set-cookie') || '';
            const sessionMatch = setCookieHeader.match(/ASP\.NET_SessionId=([^;]+)/);
            if (sessionMatch) sessionId = sessionMatch[1];
        }

        let token = '';
        const hexMatches = initHtml.match(/[a-f0-9]{64}/gi);
        if (hexMatches && hexMatches.length > 0) token = hexMatches[0];

        if (!token || !sessionId) throw new Error('Nepodařilo se získat token nebo session z GRAPPu.');

        const targetUrl = `https://grapp.spravazeleznic.cz/post/trains/GetTrainsWithFilter/${token}`;
        const payload = {"CarrierCode":["991919","992230","992719","991687","993030","990010","993188","993246","993386","993295","991950","992693","991638","991976","993089","993162","991257","992636","546001","991935","991562","993444","993303","991026","991125","993345","992644","992842","991927","993170","991810","994376","993337","993204","542005","993436","f_o_r_e_i_g_n"],"PublicKindOfTrain":["LE","Ex","Sp","rj","TL","EC","SC","Os","TLX","IC","EN","R","RJ","NJ","LET","ES"],"FreightKindOfTrain":[],"KindOfExtraordinary":[],"TrainRunning":false,"PMD":false,"TrainNoChange":0,"BckTrain":false,"TrainOutOfOrder":false,"Delay":["0","30","5","60","15","61"],"DelayMin":-99999,"DelayMax":-99999,"SearchByTrainNumber":true,"SearchByTrainName":true,"SearchByTRID":false,"SearchByVehicleNumber":false,"SearchTextType":"0","SearchPhrase":"","SelectedTrain":-1,"RequestedBy":-1,"OrderedBy":"","UnRestriction":true,"PlRestriction":true,"GPS":null,"ETCS":false};

        const dataResponse = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                'Cookie': `ASP.NET_SessionId=${sessionId}; GRAPP_TechnicalCookieName=1`,
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': 'https://grapp.spravazeleznic.cz',
                'Referer': 'https://grapp.spravazeleznic.cz/'
            },
            body: JSON.stringify(payload)
        });

        const data = await dataResponse.json();
        
        // Zde pošleme frontendu vše, co potřebuje k dalšímu dotazování
        res.json({ Token: token, SessionId: sessionId, Data: data });

    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- 2. NOVÝ ENDPOINT PRO STAŽENÍ DETAILŮ ---
app.get('/grapp/detail', async (req, res) => {
    try {
        const { id, token, session } = req.query;
        if (!id || !token || !session) return res.status(400).send("Chybí parametry");

        const targetUrl = `https://grapp.spravazeleznic.cz/OneTrain/MainInfo/${token}?trainId=${id}&_=${Date.now()}`;
        
        // Můstek (Render) připojí správné sušenky, takže nás SŽ nevykopne
        const detailResponse = await fetch(targetUrl, {
            headers: {
                'Cookie': `ASP.NET_SessionId=${session}; GRAPP_TechnicalCookieName=1`,
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': 'https://grapp.spravazeleznic.cz/'
            }
        });

        const html = await detailResponse.text();
        res.send(html);

    } catch (err) {
        res.status(500).send("Chyba při stahování detailu");
    }
});

// --- 3. NOVÝ ENDPOINT PRO TRASU VLAKU ---
app.get('/grapp/route', async (req, res) => {
    try {
        const { id, token, session } = req.query;
        if (!id || !token || !session) return res.status(400).send("Chybí parametry");

        const targetUrl = `https://grapp.spravazeleznic.cz/get/trains/train/${token}?trainId=${id}&_=${Date.now()}`;
        
        const routeResponse = await fetch(targetUrl, {
            headers: {
                'Cookie': `ASP.NET_SessionId=${session}; GRAPP_TechnicalCookieName=1`,
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': 'https://grapp.spravazeleznic.cz/'
            }
        });

        if (!routeResponse.ok) throw new Error("API SŽ selhalo");
        
        const data = await routeResponse.json();
        res.json(data);

    } catch (err) {
        res.status(500).json({ error: "Chyba při stahování trasy" });
    }
});

// --- 4. NOVÝ ENDPOINT PRO JÍZDNÍ ŘÁD VLAKU ---
app.get('/grapp/timetable', async (req, res) => {
    try {
        const { id, token, session } = req.query;
        if (!id || !token || !session) return res.status(400).send("Chybí parametry");

        const targetUrl = `https://grapp.spravazeleznic.cz/OneTrain/RouteInfo/${token}?trainId=${id}&_=${Date.now()}`;
        
        const ttResponse = await fetch(targetUrl, {
            headers: {
                'Cookie': `ASP.NET_SessionId=${session}; GRAPP_TechnicalCookieName=1`,
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': 'https://grapp.spravazeleznic.cz/'
            }
        });

        if (!ttResponse.ok) throw new Error("API SŽ selhalo");
        
        const html = await ttResponse.text();
        res.send(html);

    } catch (err) {
        res.status(500).send("Chyba při stahování jízdního řádu");
    }
});

// --- 5. ENDPOINT PRO PID (S chytrou iterací a fallbackem) ---
app.get('/pid', async (req, res) => {
    try {
        const response = await fetch('https://mapa.pid.cz/getData.php');
        if (!response.ok) throw new Error("PID API selhalo");
    
        const data = await response.json();
        
        if (data && data.trips) {
            // Iterujeme přes KLÍČE, protože PID to posílá jako objekt s IDčkama v názvech!
            for (const [key, t] of Object.entries(data.trips)) {
                
                // Extrahujeme ID
                const actualId = (typeof key === 'string' && key.includes('_')) ? key : (t.id || t.trip_id || t.tripId);
                
                // Vnutíne ID dovnitř těla dat, ať ho fronted později najde
                t.tripId = actualId;

                let cisjrData = pidTrips[actualId]; // Zkusí přesnou shodu s datem
                
                // Pokud nesedí datum (častý problém PID API vs GTFS), použijeme náš chytrý zkrácený slovník!
                if (!cisjrData && actualId) {
                    const parts = actualId.split('_');
                    if (parts.length >= 2) {
                        cisjrData = pidTripsShort[`${parts[0]}_${parts[1]}`];
                    }
                }

                // Pokud jsme našli, připojíme data
                if (cisjrData) {
                    t.cisjrLine = cisjrData.cisjrLine;
                    t.cisjrTrip = cisjrData.cisjrTrip;
                }
            }
        }
        res.json(data);
    } catch (err) {
        console.error("Chyba PID:", err);
        res.status(500).send("Chyba při stahování PID dat");
    }
});

// --- NOVÝ DIAGNOSTICKÝ ENDPOINT PRO PID ---
app.get('/pid-debug', (req, res) => {
    try {
        let filesInData = [];
        try { 
            filesInData = fs.readdirSync('./data'); 
        } catch(err) { 
            filesInData = ["Složka data/ neexistuje nebo ji nelze přečíst"]; 
        }

        // Bezpečné zjištění délky slovníku (nespadne, i když je slovník null nebo nedeklarovaný)
        const safeKeys = (obj) => {
            if (obj && typeof obj === 'object') return Object.keys(obj).length;
            return `Chyba: Není objekt (je to ${obj === null ? 'null' : typeof obj})`;
        };

        const safeGet = (obj, key) => {
            if (obj && typeof obj === 'object') return obj[key] || "Nenalezeno";
            return "Nelze hledat, slovník je poškozený";
        };

        res.json({
            status: "Debug funguje bez pádu",
            zastavek_jmk: safeKeys(typeof jmkStops !== 'undefined' ? jmkStops : null),
            spoju_pid_presnych: safeKeys(typeof pidTrips !== 'undefined' ? pidTrips : null),
            spoju_pid_zkracenych: safeKeys(typeof pidTripsShort !== 'undefined' ? pidTripsShort : null),
            soubory_ve_slozce_data: filesInData,
            test_presny_226_44_240926: safeGet(typeof pidTrips !== 'undefined' ? pidTrips : null, "226_44_240926"),
            test_zkraceny_226_44: safeGet(typeof pidTripsShort !== 'undefined' ? pidTripsShort : null, "226_44")
        });
    } catch (e) {
        // Místo chyby 500 se nám ukáže přesný důvod selhání!
        res.status(200).json({ chyba_debugu: e.message, detail: e.stack });
    }
});

// --- 6. ENDPOINT PRO DETAIL PID VOZIDLA (getVehicleWindow) ---
app.get('/pid/detail', async (req, res) => {
    try {
        const { route_type, vehicle } = req.query;
        const response = await fetch('https://mapa.pid.cz/getVehicleWindow.php', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': 'https://mapa.pid.cz',      // <-- TYTO DVĚ HLAVIČKY CHYBĚLY
                'Referer': 'https://mapa.pid.cz/'
            },
            body: JSON.stringify({
                route_type: parseInt(route_type, 10),
                vehicle: parseInt(vehicle, 10),
                past_time: false
            })
        });

        if (!response.ok) throw new Error("PID Detail API selhalo");
        const data = await response.json(); 
        res.json(data);
    } catch (err) {
        res.status(500).send("Chyba při stahování PID detailů");
    }
});

// --- 7. ENDPOINT PRO TVAR TRASY A ZASTÁVKY PID (getShape) ---
app.get('/pid/shape', async (req, res) => {
    try {
        const { id } = req.query;
        const response = await fetch('https://mapa.pid.cz/getShape.php', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': 'https://mapa.pid.cz',      // <-- I SEM PRO JISTOTU
                'Referer': 'https://mapa.pid.cz/'
            },
            body: JSON.stringify({
                id: id,
                past_time: false
            })
        });

        if (!response.ok) throw new Error("PID Shape API selhalo");
        const data = await response.json(); 
        res.json(data);
    } catch (err) {
        res.status(500).send("Chyba při stahování tvaru PID trasy");
    }
});

// --- 8. ENDPOINT PRO JÍZDNÍ ŘÁD PID (getTimetable) ---
app.get('/pid/timetable', async (req, res) => {
    try {
        const { trip_id, vehicle } = req.query;
        const response = await fetch('https://mapa.pid.cz/getTimetable.php', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': 'https://mapa.pid.cz',
                'Referer': 'https://mapa.pid.cz/'
            },
            body: JSON.stringify({
                trip_id: trip_id,
                vehicle: vehicle ? vehicle : ""
            })
        });

        if (!response.ok) throw new Error("PID Timetable API selhalo");
        const data = await response.json(); 
        if (data && data.Vehicles) {
            data.Vehicles.forEach(v => {
                if (v.LastStopID && jmkStops[v.LastStopID]) {
                    // Do JSONu přidáme zbrusu nový klíč, který originální API nemá
                    v.LastStopName = jmkStops[v.LastStopID];
                }
            });
        }
        res.json(data);
    } catch (err) {
        res.status(500).send("Chyba při stahování PID jízdního řádu");
    }
});

// Paměť pro aktuálně platný token (začneme tím tvým úlovkem)
let jmkToken = 'fFdFQnwyODczZjViZS1lNmMwLTQwMWItOGJmMC05MmRiMzJkMmRmZWY=';

// --- FUNKCE PRO AUTOMATICKÉ NALEZENÍ NOVÉHO TOKENU ---
async function refreshJmkToken() {
    console.log("IDS JMK token pravděpodobně vypršel. Hledám nový ze zdrojových kódů...");
    try {
        // 1. Stáhneme hlavní HTML stránku
        const response = await fetch('https://mapa.idsjmk.cz/');
        const html = await response.text();
        
        // Regulární výraz pro hledání Base64 textu začínajícího na fFdFQnw ("|WEB|")
        const tokenRegex = /(fFdFQnw[A-Za-z0-9+/=]+)/;
        
        // 2. Prohledáme nejprve samotné HTML
        let match = html.match(tokenRegex);
        if (match && match[1]) {
            jmkToken = match[1];
            console.log("Auto-Heal: Nový token nalezen přímo v HTML.");
            return true;
        }

        // 3. Většinou je ale v moderních webech token skrytý až v načtených .js souborech (React/Angular)
        const scriptMatches = [...html.matchAll(/<script[^>]+src="([^">]+)"/g)];
        for (const scriptMatch of scriptMatches) {
            let scriptUrl = scriptMatch[1];
            if (!scriptUrl.startsWith('http')) {
                scriptUrl = 'https://mapa.idsjmk.cz' + (scriptUrl.startsWith('/') ? '' : '/') + scriptUrl;
            }

            const scriptRes = await fetch(scriptUrl);
            const scriptText = await scriptRes.text();
            
            match = scriptText.match(tokenRegex);
            if (match && match[1]) {
                jmkToken = match[1];
                console.log(`Auto-Heal: Nový token nalezen v JS souboru (${scriptUrl}).`);
                return true;
            }
        }

        console.error("Auto-Heal selhal: Token se nepodařilo najít.");
        return false;
    } catch (err) {
        console.error("Chyba při vyhledávání nového tokenu:", err);
        return false;
    }
}

// --- POMOCNÁ FUNKCE PRO VOLÁNÍ API JMK (S Auto-Healingem) ---
async function fetchJmkApi(url) {
    let options = {
        headers: {
            'accept': 'application/json, text/plain, */*',
            'Origin': 'https://mapa.idsjmk.cz',
            'Referer': 'https://mapa.idsjmk.cz/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'x-access-token': jmkToken
        }
    };

    let response = await fetch(url, options);

    // Pokud token vypršel, spustíme obnovu a zkusíme to znovu
    if (response.status === 401 || response.status === 403) {
        const refreshed = await refreshJmkToken();
        if (refreshed) {
            options.headers['x-access-token'] = jmkToken;
            response = await fetch(url, options);
        }
    }

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API JMK zamítlo přístup: ${response.status} - ${text}`);
    }
    
    return await response.json();
}

// --- 9A. ENDPOINT PRO IDS JMK (Základní polohy) ---
app.get('/idsjmk', async (req, res) => {
    try {
        const data = await fetchJmkApi('https://mapa.idsjmk.cz/api/vehicles');
        
        if (data && data.Vehicles) {
            data.Vehicles.forEach(v => {
                if (v.LastStopID) {
                    const name = manualStops[v.LastStopID] || jmkStops[v.LastStopID];
                    if (name) v.LastStopName = name;
                }
            });
        }
        res.json(data);
    } catch (err) {
        console.error("Chyba IDS JMK Polohy:", err.message);
        res.status(500).send(err.message);
    }
});

// --- 9B. ENDPOINT PRO IDS JMK (Trasa na mapě) ---
app.get('/idsjmk-route', async (req, res) => {
    try {
        const { serviceid, lineid, routeid } = req.query;
        const data = await fetchJmkApi(`https://mapa.idsjmk.cz/api/routepath?serviceid=${serviceid}&lineid=${lineid}&routeid=${routeid}`);
        res.json(data);
    } catch (err) {
        console.error("Chyba IDS JMK Trasa:", err.message);
        res.status(500).send(err.message);
    }
});

// --- 9C. ENDPOINT PRO IDS JMK (Jízdní řád) ---
app.get('/idsjmk-timetable', async (req, res) => {
    try {
        const { serviceid, lineid, routeid } = req.query;
        const data = await fetchJmkApi(`https://mapa.idsjmk.cz/api/serviceinfo?serviceid=${serviceid}&lineid=${lineid}&routeid=${routeid}`);
        
        if (data && data.Routes && data.Routes.length > 0) {
            data.Routes[0].Stops.forEach(stop => {
                const name = manualStops[stop.StopId] || jmkStops[stop.StopId];
                stop.HasName = !!name;
                stop.StopName = name ? name : `Zastávka ID: ${stop.StopId}`;
                stop.IsVisible = stop.HasName || stop.IsPublic === true;
            });
        }
        res.json(data);
    } catch (err) {
        console.error("Chyba IDS JMK JŘ:", err.message);
        res.status(500).send(err.message);
    }
});

// Pomocná funkce pro výpočet azimutu (vychází ze sférické geometrie)
function calculateBearing(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => deg * Math.PI / 180;
    const toDeg = (rad) => rad * 180 / Math.PI;

    const startLat = toRad(lat1);
    const startLng = toRad(lon1);
    const destLat = toRad(lat2);
    const destLng = toRad(lon2);

    const y = Math.sin(destLng - startLng) * Math.cos(destLat);
    const x = Math.cos(startLat) * Math.sin(destLat) -
              Math.sin(startLat) * Math.cos(destLat) * Math.cos(destLng - startLng);
    
    let bearing = Math.atan2(y, x);
    return (toDeg(bearing) + 360) % 360;
}

// Globální paměť pro uchování poloh VDV vozidel
let vdvVehicleStates = {};

// --- 10. ENDPOINT PRO VDV (Hlavní data) ---
app.get('/vdv', async (req, res) => {
    try {
        const targetUrl = `https://mapavdv.kr-vysocina.cz/Ajax/GetPoints?t=${Date.now()}`;
        const response = await fetch(targetUrl);
        if (!response.ok) throw new Error("VDV API selhalo");
        
        const data = await response.json();
        const currentIds = new Set();

        data.forEach(trip => {
            currentIds.add(trip.id);

            // Pokud vidíme vozidlo poprvé, uložíme ho s nullovým směrem
            if (!vdvVehicleStates[trip.id]) {
                vdvVehicleStates[trip.id] = {
                    lat: trip.lat,
                    lng: trip.lng,
                    heading: null,
                    staticCount: 0
                };
                trip.heading = null;
            } else {
                const state = vdvVehicleStates[trip.id];

                // Pokud jsou souřadnice úplně stejné
                if (state.lat === trip.lat && state.lng === trip.lng) {
                    state.staticCount++;
                    // Pokud vozidlo stojí déle než 30 iterací (cca 5 min), vymažeme mu směr (vrátí se na kroužek)
                    if (state.staticCount > 30) {
                        state.heading = null;
                    }
                } else {
                    // Vozidlo se pohnulo -> Vypočítáme nový směr a vynulujeme čítač stání
                    state.heading = calculateBearing(state.lat, state.lng, trip.lat, trip.lng);
                    state.lat = trip.lat;
                    state.lng = trip.lng;
                    state.staticCount = 0;
                }
                
                // Přilepíme spočítaný směr přímo do odesílaného JSONu
                trip.heading = state.heading;
            }
        });

        // Garbage Collector: Vymažeme z paměti vozidla, která už z VDV API zmizela (zabráníme přetečení paměti)
        for (const id in vdvVehicleStates) {
            if (!currentIds.has(Number(id))) {
                delete vdvVehicleStates[id];
            }
        }

        res.json(data);
    } catch (err) {
        console.error("Chyba VDV GetPoints:", err.message);
        res.status(500).send("Chyba při stahování VDV dat");
    }
});

// --- 11. ENDPOINT PRO VDV (Detail vozidla) ---
app.get('/vdv/detail', async (req, res) => {
    try {
        const { id } = req.query;
        if (!id) return res.status(400).send("Chybí ID");

        const targetUrl = `https://mapavdv.kr-vysocina.cz/Ajax/OpenInfoWindow?id=${id}&t=${Date.now()}`;
        const response = await fetch(targetUrl);
        if (!response.ok) throw new Error("VDV Detail API selhalo");
        
        const html = await response.text();
        res.send(html);
    } catch (err) {
        console.error("Chyba VDV Detail:", err.message);
        res.status(500).send("Chyba při stahování VDV detailů");
    }
});

// --- 12. ENDPOINT PRO VDV (Jízdní řád) ---
app.get('/vdv/timetable', async (req, res) => {
    try {
        const { id } = req.query;
        if (!id) return res.status(400).send("Chybí ID");

        const targetUrl = `https://mapavdv.kr-vysocina.cz/Ajax/GetTimetable?vehicleNumber=${id}&currentStopId=0&t=${Date.now()}`;
        const response = await fetch(targetUrl);
        if (!response.ok) throw new Error("VDV Timetable API selhalo");
        
        const html = await response.text();
        res.send(html);
    } catch (err) {
        console.error("Chyba VDV Timetable:", err.message);
        res.status(500).send("Chyba při stahování VDV JŘ");
    }
});

async function initVdvGtfsOnDemand() {
    if (isVdvIndexing || isVdvReady) return;
    isVdvIndexing = true;
    console.log("Zahajuji on-demand přípravu GTFS dat pro VDV Vysočina...");

    try {
        const gtfsDir = path.join(__dirname, 'gtfs_data');
        if (!fs.existsSync(gtfsDir)) fs.mkdirSync(gtfsDir);

        const zipPath = path.join(gtfsDir, 'gtfs.zip');
        let needDownload = true;

        // Pokud ZIP existuje a je mladší než 7 dní, nestahujeme znovu
        if (fs.existsSync(zipPath)) {
            const stats = fs.statSync(zipPath);
            const ageDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
            if (ageDays < 7) needDownload = false;
        }

        if (needDownload) {
            console.log("Stahuji celostátní JŘ ze Spojenky...");
            const res = await fetch('https://www.spojenka.cz/jrdata/jizdnirady-gtfs.zip');
            if (!res.ok) throw new Error("Nelze stáhnout GTFS ZIP");
            const buffer = await res.arrayBuffer();
            fs.writeFileSync(zipPath, Buffer.from(buffer));

            console.log("Rozbaluji GTFS data na disk...");
            const zip = new AdmZip(zipPath);
            zip.extractAllTo(gtfsDir, true);
        }

        // Pomocná funkce pro bezpečné parsování CSV řádků s uvozovkami
        const parseCsv = (line) => {
            const res = []; let curr = ''; let inQ = false;
            for (let i = 0; i < line.length; i++) {
                if (line[i] === '"' && line[i+1] === '"') { curr += '"'; i++; }
                else if (line[i] === '"') inQ = !inQ;
                else if (line[i] === ',' && !inQ) { res.push(curr.trim()); curr = ''; }
                else curr += line[i];
            }
            res.push(curr.trim()); return res;
        };

        // 1. Indexujeme stops.txt do paměti (pár tisíc řádků = zanedbatelná RAM)
        console.log("Indexuji souřadnice zastávek...");
        let fileStream = fs.createReadStream(path.join(gtfsDir, 'stops.txt'));
        let rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
        let headers = null;
        for await (const line of rl) {
            if (!headers) { headers = parseCsv(line); continue; }
            const cols = parseCsv(line);
            const id = cols[headers.indexOf('stop_id')];
            const lat = parseFloat(cols[headers.indexOf('stop_lat')]);
            const lon = parseFloat(cols[headers.indexOf('stop_lon')]);
            if (id && !isNaN(lat)) vdvStopsMap.set(id, [lon, lat]);
        }

        // 2. Indexujeme routes.txt pro převod interního ID na CISJR číslo linky
        console.log("Indexuji mapování linek...");
        fileStream = fs.createReadStream(path.join(gtfsDir, 'routes.txt'));
        rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
        headers = null;
        const routeToCisjr = new Map();
        for await (const line of rl) {
            if (!headers) { headers = parseCsv(line); continue; }
            const cols = parseCsv(line);
            const rId = cols[headers.indexOf('route_id')];
            const rel = cols[headers.indexOf('relations')];
            if (rId && rel) {
                const match = rel.match(/CISJR:(\d{6})/);
                if (match) routeToCisjr.set(rId, match[1]);
            }
        }

        // 3. Indexujeme trips.txt -> vytvoříme bleskový vyhledávací strom "841129_25" -> trip_id
        console.log("Indexuji ID jednotlivých spojů...");
        fileStream = fs.createReadStream(path.join(gtfsDir, 'trips.txt'));
        rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
        headers = null;
        for await (const line of rl) {
            if (!headers) { headers = parseCsv(line); continue; }
            const cols = parseCsv(line);
            const rId = cols[headers.indexOf('route_id')];
            const tId = cols[headers.indexOf('trip_id')];
            const rel = cols[headers.indexOf('relations')];
            if (rId && tId && rel && routeToCisjr.has(rId)) {
                const cisjrLine = routeToCisjr.get(rId);
                const match = rel.match(/CISJR:(\d+)/);
                if (match) {
                    vdvTripIdMap.set(`${cisjrLine}_${match[1]}`, tId);
                }
            }
        }

        isVdvReady = true;
        console.log(`Můstek úspěšně připraven! On-demand zaindexováno ${vdvTripIdMap.size} VDV spojů.`);
    } catch (err) {
        console.error("Kritická chyba inicializace on-demand VDV:", err.message);
    } finally {
        isVdvIndexing = false;
    }
}

// Nastartujeme indexaci okamžitě při spuštění Můstku na Renderu
initVdvGtfsOnDemand();

// --- NOVÝ DYNAMICKÝ ROUTE ENDPOINT ---
app.get('/vdv/route', async (req, res) => {
    try {
        const { id } = req.query; // Přijde např. "841129_25"
        
        if (!isVdvReady) {
            initVdvGtfsOnDemand(); // Sychr re-inicializace
            return res.json({ shape: null, status: "Server stále indexuje GTFS, opakujte akci za chvíli." });
        }

        // Zjistíme trip_id z našeho paměťového indexu (zabere 0 milisekund)
        const tripId = vdvTripIdMap.get(id);
        if (!tripId) return res.json({ shape: null, error: "Spoj nenalezen v celostátním registru" });

        // Streamujeme obrovský stop_times.txt po řádcích (RAM spotřeba cca 2 MB)
        const stopTimesPath = path.join(__dirname, 'gtfs_data', 'stop_times.txt');
        const fileStream = fs.createReadStream(stopTimesPath);
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

        let headers = null;
        let tIdx = -1, sIdx = -1, seqIdx = -1;
        const rawStops = [];

        for await (const line of rl) {
            if (!headers) {
                headers = line.split(',').map(h => h.trim().replace(/"/g, ''));
                tIdx = headers.indexOf('trip_id');
                sIdx = headers.indexOf('stop_id');
                seqIdx = headers.indexOf('stop_sequence');
                continue;
            }

            // Ultra-rychlý předběžný filtr před složitým splitováním řádku
            if (!line.includes(tripId)) continue;

            const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
            if (cols[tIdx] === tripId) {
                const stopId = cols[sIdx];
                const seq = parseInt(cols[seqIdx], 10);
                const coords = vdvStopsMap.get(stopId);
                if (coords) {
                    rawStops.push({ seq, coords });
                }
            }
        }

        if (rawStops.length < 2) return res.json({ shape: null });

        // Seřadíme zastávky podle pořadí jízdy
        rawStops.sort((a, b) => a.seq - b.seq);
        const coords = rawStops.map(s => s.coords); // Hrubé body [[lon, lat], ...]

        // Proženeme vytažené souřadnice skrze OSRM asfaltový vyhlazovač
        const coordString = coords.map(pt => `${pt[0]},${pt[1]}`).join(';');
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coordString}?overview=full&geometries=geojson`;
        
        const osrmRes = await fetch(osrmUrl);
        if (!osrmRes.ok) {
            return res.json({ shape: coords }); // Fallback na čisté spojnice zastávek při výpadku OSRM
        }

        const osrmData = await osrmRes.json();
        if (osrmData.routes && osrmData.routes.length > 0) {
            return res.json({ shape: osrmData.routes[0].geometry.coordinates });
        }

        res.json({ shape: coords });
    } catch (error) {
        console.error("Chyba při on-demand routování:", error.message);
        res.json({ shape: null });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GRAPP Můstek naslouchá na portu ${PORT}`));
