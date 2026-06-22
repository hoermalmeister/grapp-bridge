import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
app.use(cors());

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
        res.json(data);
    } catch (err) {
        res.status(500).send("Chyba při stahování PID jízdního řádu");
    }
});

// --- 9. ENDPOINT PRO IDS JMK (S dynamickým tokenem a ochranou proti pádům) ---
app.get('/idsjmk', async (req, res) => {
    try {
        // 1. Spolehlivý generátor UUID nezávislý na verzi Node.js (nemusíš importovat crypto)
        const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
        
        // 2. Složení tokenu
        const rawToken = `|WEB|${uuid}`;
        const accessToken = Buffer.from(rawToken).toString('base64');

        // 3. Odeslání dotazu s kompletními hlavičkami (včetně User-Agent proti blokaci)
        const response = await fetch('https://mapa.idsjmk.cz/api/vehicles', {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Origin': 'https://mapa.idsjmk.cz',
                'Referer': 'https://mapa.idsjmk.cz/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'x-access-token': accessToken 
            }
        });

        // 4. Pokud server IDS JMK vrátí chybu, zachytíme ji
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`API JMK zamítlo přístup: ${response.status} - ${text}`);
        }
        
        const data = await response.json(); 
        res.json(data);
    } catch (err) {
        // Vypíše chybu do logů Renderu a pošle ji jako text na frontend
        console.error("Chyba IDS JMK Můstku:", err.message);
        res.status(500).send(err.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GRAPP Můstek naslouchá na portu ${PORT}`));
