import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());

app.get('/grapp', async (req, res) => {
    try {
        console.log("--- ZAČÍNÁM DOTAZ NA SŽ ---");
        
        // 1. Tváříme se jako opravdový prohlížeč (jinak nás firewall SŽ může zablokovat)
        const initResponse = await fetch('https://grapp.spravazeleznic.cz/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'cs,en-US;q=0.7,en;q=0.3',
                'Connection': 'keep-alive'
            }
        });

        if (!initResponse.ok) {
            throw new Error(`Hlavní stránka SŽ vrátila chybu: ${initResponse.status}`);
        }

        const initHtml = await initResponse.text();

        // 2. Extrakce Session Cookie (Node 18+ má getSetCookie, jinak fallback)
        let sessionId = '';
        if (initResponse.headers.getSetCookie) {
            const cookies = initResponse.headers.getSetCookie();
            for (const cookie of cookies) {
                if (cookie.includes('ASP.NET_SessionId')) {
                    sessionId = cookie.split(';')[0].split('=')[1];
                }
            }
        }
        
        // Fallback pro jistotu
        if (!sessionId) {
            const setCookieHeader = initResponse.headers.get('set-cookie') || '';
            const sessionMatch = setCookieHeader.match(/ASP\.NET_SessionId=([^;]+)/);
            if (sessionMatch) sessionId = sessionMatch[1];
        }

        // 3. Extrakce Tokenu z HTML (více benevolentní regex)
        // Hledáme např. "GetTrainsWithFilter/CDBD03CC..."
        const tokenMatch = initHtml.match(/GetTrainsWithFilter\/([A-Za-z0-9]+)/i);
        const token = tokenMatch ? tokenMatch[1] : '';

        // DETAILNÍ LOGOVÁNÍ PRO NÁS
        console.log(`Získaný Session ID: ${sessionId ? "OK (" + sessionId.substring(0, 5) + "...)" : "CHYBÍ!"}`);
        console.log(`Získaný Token:      ${token ? "OK (" + token.substring(0, 5) + "...)" : "CHYBÍ!"}`);

        // Pokud něco chybí, vyhodíme detailnější chybu
        if (!token || !sessionId) {
            return res.status(500).json({ 
                error: 'Nepodařilo se získat token nebo session z GRAPPu.',
                debug: {
                    hasSession: !!sessionId,
                    hasToken: !!token
                }
            });
        }

        // 4. Pokud máme vše, jdeme pro data
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
                'Referer': 'https://grapp.spravazeleznic.cz/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            body: JSON.stringify(payload)
        });

        if (!dataResponse.ok) {
            const errorText = await dataResponse.text();
            throw new Error(`Data SŽ vrátila chybu ${dataResponse.status}: ${errorText.substring(0, 100)}`);
        }
        
        const data = await dataResponse.json();
        
        // Zkontrolujeme, jestli nám SŽ nevrací tu jejich "fake" chybu v rámci JSONu
        if (data && data.Status && data.Status.includes("Pokus o neautorizovaný přístup")) {
             throw new Error("SŽ odmítla přístup i přes platný token. Je možné, že blokuje IP adresy Renderu.");
        }

        console.log(`--- ÚSPĚŠNĚ STAŽENO VOZIDEL: ${data.Trains ? data.Trains.length : 0} ---`);
        res.json(data);

    } catch (error) {
        console.error("Kritická chyba v můstku:", error.message);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`GRAPP Můstek naslouchá na portu ${PORT}`);
});
