import express from 'express';
import cors from 'cors';

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GRAPP Můstek naslouchá na portu ${PORT}`));
