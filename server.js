import express from 'express';
import cors from 'cors';
import AdmZip from 'adm-zip';

const app = express();
app.use(cors());

let jmkStops = {};
let pidTrips = {};

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
    }
    console.log(`Data úspěšně načtena z disku. (JMK zastávek: ${Object.keys(jmkStops).length}, PID spojů: ${Object.keys(pidTrips).length})`);
} catch (e) {
    console.warn("Upozornění: JSON data zatím neexistují. Github Action je vytvoří v noci.");
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

// --- 5. NOVÝ ENDPOINT PRO PID ---
app.get('/pid', async (req, res) => {
    try {
        // Tady backend stáhne data z PIDu (serverům CORS nevadí)
        const response = await fetch('https://mapa.pid.cz/getData.php');
        if (!response.ok) throw new Error("PID API selhalo");
    
        const data = await response.json();
        
        if (data && data.trips) {
            data.trips.forEach(t => {
                if (t.tripId && pidTrips[t.tripId]) {
                    t.cisjrLine = pidTrips[t.tripId].cisjrLine;
                    t.cisjrTrip = pidTrips[t.tripId].cisjrTrip;
                }
            });
        }
        res.json(data); // A rovnou je pošle tvému webu
    } catch (err) {
        console.error("Chyba PID:", err);
        res.status(500).send("Chyba při stahování PID dat");
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GRAPP Můstek naslouchá na portu ${PORT}`));
