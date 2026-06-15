import express from 'express';
import cors from 'cors';

const app = express();

// Povolí přístup odkudkoliv (řeší problém s CORS na frontendu)
app.use(cors());

app.get('/grapp', async (req, res) => {
    try {
        console.log("Stahuji data ze SŽ...");
        
        // 1. Stáhneme hlavní stránku pro získání Cookie a Tokenu
        const initResponse = await fetch('https://grapp.spravazeleznic.cz/');
        const initHtml = await initResponse.text();

        // Extrakce ASP.NET Session Cookie
        const setCookieHeader = initResponse.headers.get('set-cookie') || '';
        let sessionId = '';
        const sessionMatch = setCookieHeader.match(/ASP\.NET_SessionId=([^;]+)/);
        if (sessionMatch) sessionId = sessionMatch[1];

        // Extrakce dynamického Tokenu z HTML
        const tokenMatch = initHtml.match(/GetTrainsWithFilter\/([A-Z0-9]{64})/i);
        const token = tokenMatch ? tokenMatch[1] : '';

        if (!token || !sessionId) {
            return res.status(500).json({ error: 'Nepodařilo se získat token nebo session z GRAPPu.' });
        }

        // 2. Odeslání požadavku na konkrétní data
        const targetUrl = `https://grapp.spravazeleznic.cz/post/trains/GetTrainsWithFilter/${token}`;
        
        const payload = {
            "CarrierCode":["991919","992230","992719","991687","993030","990010","993188","993246","993386","993295","991950","992693","991638","991976","993089","993162","991257","992636","546001","991935","991562","993444","993303","991026","991125","993345","992644","992842","991927","993170","991810","994376","993337","993204","542005","993436","f_o_r_e_i_g_n"],
            "PublicKindOfTrain":["LE","Ex","Sp","rj","TL","EC","SC","Os","TLX","IC","EN","R","RJ","NJ","LET","ES"],
            "FreightKindOfTrain":[],"KindOfExtraordinary":[],"TrainRunning":false,"PMD":false,"TrainNoChange":0,
            "BckTrain":false,"TrainOutOfOrder":false,"Delay":["0","30","5","60","15","61"],"DelayMin":-99999,
            "DelayMax":-99999,"SearchByTrainNumber":true,"SearchByTrainName":true,"SearchByTRID":false,
            "SearchByVehicleNumber":false,"SearchTextType":"0","SearchPhrase":"","SelectedTrain":-1,
            "RequestedBy":-1,"OrderedBy":"","UnRestriction":true,"PlRestriction":true,"GPS":null,"ETCS":false
        };

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

        if (!dataResponse.ok) throw new Error(`Chyba API SŽ: ${dataResponse.status}`);
        
        // 3. Pošleme čistý JSON zpět našemu frontendu
        const data = await dataResponse.json();
        res.json(data);

    } catch (error) {
        console.error("Chyba při komunikaci s GRAPP:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// Zajištění funkčnosti na Renderu, který přiřazuje dynamický port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`GRAPP Můstek naslouchá na portu ${PORT}`);
});
