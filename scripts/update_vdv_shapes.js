import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..', 'data');
const gtfsDir = path.join(__dirname, '..', 'gtfs_raw');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runSegmentRouting() {
    console.log("1. Načítám zastávky (stops.txt)...");
    const stopMap = new Map();
    let rl = readline.createInterface({ input: fs.createReadStream(path.join(gtfsDir, 'stops.txt')) });
    let headers = null;
    for await (const line of rl) {
        if (!headers) { headers = parseCsv(line); continue; }
        const cols = parseCsv(line);
        const sId = cols[headers.indexOf('stop_id')];
        const lat = parseFloat(cols[headers.indexOf('stop_lat')]);
        const lon = parseFloat(cols[headers.indexOf('stop_lon')]);
        if (sId && !isNaN(lat)) stopMap.set(sId, { lat, lon });
    }

    console.log("2. Hledám VDV linky přes CISJR (routes.txt)...");
    const routeToCisjr = new Map();
    rl = readline.createInterface({ input: fs.createReadStream(path.join(gtfsDir, 'routes.txt')) });
    headers = null;
    for await (const line of rl) {
        if (!headers) { headers = parseCsv(line); continue; }
        const cols = parseCsv(line);
        const rel = cols[headers.indexOf('relations')];
        if (rel) {
            const match = rel.match(/CISJR:(\d{6})/);
            if (match) routeToCisjr.set(cols[headers.indexOf('route_id')], match[1]);
        }
    }

    console.log("3. Hledám VDV spoje (trips.txt)...");
    const tripToCisjr = new Map();
    rl = readline.createInterface({ input: fs.createReadStream(path.join(gtfsDir, 'trips.txt')) });
    headers = null;
    for await (const line of rl) {
        if (!headers) { headers = parseCsv(line); continue; }
        const cols = parseCsv(line);
        const rId = cols[headers.indexOf('route_id')];
        const tId = cols[headers.indexOf('trip_id')];
        const rel = cols[headers.indexOf('relations')];
        if (routeToCisjr.has(rId) && rel) {
            const match = rel.match(/CISJR:(\d+)/);
            if (match) tripToCisjr.set(tId, `${routeToCisjr.get(rId)}_${match[1]}`);
        }
    }
    console.log(` > Nalezeno ${tripToCisjr.size} VDV spojů.`);

    console.log("4. Tvořím sekvence zastávek (stop_times.txt)...");
    const tripSequences = new Map();
    rl = readline.createInterface({ input: fs.createReadStream(path.join(gtfsDir, 'stop_times.txt')) });
    headers = null;
    
    for await (const line of rl) {
        if (!headers) { headers = parseCsv(line); continue; }
        
        const firstComma = line.indexOf(',');
        const tIdRaw = line.substring(0, firstComma).replace(/"/g, ''); 
        const cisjrId = tripToCisjr.get(tIdRaw);
        
        if (cisjrId) {
            const cols = parseCsv(line);
            const sId = cols[headers.indexOf('stop_id')];
            if (stopMap.has(sId)) {
                if (!tripSequences.has(cisjrId)) tripSequences.set(cisjrId, []);
                tripSequences.get(cisjrId).push({
                    seq: parseInt(cols[headers.indexOf('stop_sequence')], 10),
                    stop_id: sId
                });
            }
        }
    }

    console.log("5. Vytvářím unikátní traťové segmenty...");
    const uniqueSegments = new Set();
    const finalTrips = {};

    for (const [cisjrId, stops] of tripSequences.entries()) {
        stops.sort((a, b) => a.seq - b.seq);
        if (stops.length < 2) continue;
        
        finalTrips[cisjrId] = [];
        for (let i = 0; i < stops.length - 1; i++) {
            const s1 = stops[i].stop_id;
            const s2 = stops[i + 1].stop_id;
            const segKey = `${s1}|${s2}`;
            
            uniqueSegments.add(segKey);
            finalTrips[cisjrId].push(segKey);
        }
    }
    console.log(` > Získáno ${uniqueSegments.size} UNIKÁTNÍCH traťových úseků ke zpracování.`);

    console.log("6. Komunikuji s OSRM API (Může trvat několik minut)...");
    const finalSegments = {};
    let processed = 0;

    for (const segKey of uniqueSegments) {
        const [s1, s2] = segKey.split('|');
        const p1 = stopMap.get(s1);
        const p2 = stopMap.get(s2);

        if (p1.lat === p2.lat && p1.lon === p2.lon) {
            finalSegments[segKey] = [[p1.lon, p1.lat]];
            continue;
        }

        try {
            const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${p1.lon},${p1.lat};${p2.lon},${p2.lat}?overview=full&geometries=geojson`;
            const req = await fetch(osrmUrl);
            if (req.ok) {
                const data = await req.json();
                if (data.routes && data.routes.length > 0) {
                    finalSegments[segKey] = data.routes[0].geometry.coordinates;
                } else {
                    finalSegments[segKey] = [[p1.lon, p1.lat], [p2.lon, p2.lat]];
                }
            } else {
                finalSegments[segKey] = [[p1.lon, p1.lat], [p2.lon, p2.lat]];
            }
        } catch (e) {
            finalSegments[segKey] = [[p1.lon, p1.lat], [p2.lon, p2.lat]];
        }

        processed++;
        if (processed % 100 === 0) console.log(`   > Vyhlazeno ${processed}/${uniqueSegments.size} segmentů...`);
        
        // Zpoždění proti zablokování OSRM API
        await sleep(150); 
    }

    console.log("7. Ukládám výsledky...");
    fs.writeFileSync(path.join(dataDir, 'vdv_segments.json'), JSON.stringify(finalSegments));
    fs.writeFileSync(path.join(dataDir, 'vdv_trips.json'), JSON.stringify(finalTrips));
    
    console.log(`\nHOTOVO! Úspěšně uloženo.`);
}

runSegmentRouting().catch(e => {
    console.error("Kritická chyba ve skriptu:", e);
    process.exit(1); // Zabije proces a Action zčervená!
});
