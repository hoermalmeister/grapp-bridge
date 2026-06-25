import fs from 'fs';
import path from 'path';
import readline from 'readline';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Pomocná funkce na parsování CSV
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

// Slušné čekání pro OSRM API (abychom nedostali ban)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runSegmentRouting() {
    console.log("1. Stahuji celostátní GTFS ze Spojenky...");
    const res = await fetch('https://www.spojenka.cz/jrdata/jizdnirady-gtfs.zip');
    if (!res.ok) throw new Error("Nelze stáhnout GTFS ZIP");
    const buffer = await res.arrayBuffer();
    const zip = new AdmZip(Buffer.from(buffer));

    const getFileStream = (fileName) => {
        const entry = zip.getEntries().find(e => e.entryName === fileName);
        if (!entry) throw new Error(`Soubor ${fileName} chybí v ZIPu`);
        const text = zip.readAsText(entry, 'utf8');
        const stream = require('stream');
        return stream.Readable.from(text);
    };

    // --- KROK 1: ZASTÁVKY (Filtrujeme pouze ty, co mají v zone_id 'V') ---
    console.log("2. Analyzuji stops.txt...");
    const validStops = new Map(); // stop_id -> {lat, lon}
    let rl = readline.createInterface({ input: getFileStream('stops.txt') });
    let headers = null;
    for await (const line of rl) {
        if (!headers) { headers = parseCsv(line); continue; }
        const cols = parseCsv(line);
        const zoneId = cols[headers.indexOf('zone_id')];
        if (zoneId && zoneId.includes('V')) {
            validStops.set(cols[headers.indexOf('stop_id')], {
                lat: parseFloat(cols[headers.indexOf('stop_lat')]),
                lon: parseFloat(cols[headers.indexOf('stop_lon')])
            });
        }
    }
    console.log(`Nalezeno ${validStops.size} VDV zastávek.`);

    // --- KROK 2: LINKY (routes.txt -> route_id: "841129") ---
    console.log("3. Mapuji linky...");
    const routeToCisjr = new Map();
    rl = readline.createInterface({ input: getFileStream('routes.txt') });
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

    // --- KROK 3: SPOJE (trips.txt -> trip_id: "841129_25") ---
    console.log("4. Mapuji spoje...");
    const tripToCisjr = new Map();
    rl = readline.createInterface({ input: getFileStream('trips.txt') });
    headers = null;
    for await (const line of rl) {
        if (!headers) { headers = parseCsv(line); continue; }
        const cols = parseCsv(line);
        const rId = cols[headers.indexOf('route_id')];
        const tId = cols[headers.indexOf('trip_id')];
        const rel = cols[headers.indexOf('relations')];
        if (routeToCisjr.has(rId) && rel) {
            const match = rel.match(/CISJR:(\d+)/);
            if (match) {
                tripToCisjr.set(tId, `${routeToCisjr.get(rId)}_${match[1]}`);
            }
        }
    }

    // --- KROK 4: ZASTÁVKOVÉ ČASY (stop_times.txt -> skládání sekvencí) ---
    console.log("5. Čtu stop_times.txt a tvořím sekvence zastávek...");
    const tripSequences = new Map(); // cisjr_id -> [ {seq, stop_id} ]
    rl = readline.createInterface({ input: getFileStream('stop_times.txt') });
    headers = null;
    
    for await (const line of rl) {
        if (!headers) { headers = parseCsv(line); continue; }
        
        // Rychlý pre-check abychom neparsovali nepotřebné řádky
        const firstComma = line.indexOf(',');
        const tIdRaw = line.substring(0, firstComma).replace(/"/g, ''); 
        const cisjrId = tripToCisjr.get(tIdRaw);
        
        if (cisjrId) {
            const cols = parseCsv(line);
            const sId = cols[headers.indexOf('stop_id')];
            // ORPHAN FILTER: Ponecháme jen zastávky patřící pod VDV
            if (validStops.has(sId)) {
                if (!tripSequences.has(cisjrId)) tripSequences.set(cisjrId, []);
                tripSequences.get(cisjrId).push({
                    seq: parseInt(cols[headers.indexOf('stop_sequence')], 10),
                    stop_id: sId
                });
            }
        }
    }

    // --- KROK 5: TVORBA UNIKÁTNÍCH SEGMENTŮ A KOSTER SPOJŮ ---
    console.log("6. Tvořím unikátní segmenty a kostry spojů...");
    const uniqueSegments = new Set(); // Uchová 'stopA_stopB'
    const finalTrips = {}; // "841129_25": ["stopA_stopB", "stopB_stopC", ...]

    for (const [cisjrId, stops] of tripSequences.entries()) {
        stops.sort((a, b) => a.seq - b.seq); // Seřadíme zastávky
        
        if (stops.length < 2) continue; // Ignorujeme osiřelé jednokolejky
        
        finalTrips[cisjrId] = [];
        for (let i = 0; i < stops.length - 1; i++) {
            const s1 = stops[i].stop_id;
            const s2 = stops[i + 1].stop_id;
            const segKey = `${s1}|${s2}`;
            
            uniqueSegments.add(segKey);
            finalTrips[cisjrId].push(segKey);
        }
    }

    console.log(`   > Získáno ${Object.keys(finalTrips).length} platných VDV spojů.`);
    console.log(`   > Nalezeno ${uniqueSegments.size} UNIKÁTNÍCH traťových úseků ke zpracování.`);

    // --- KROK 6: ROUTOVÁNÍ SEGMENTŮ PŘES OSRM ---
    console.log("7. Komunikuji s OSRM API (To chvíli potrvá)...");
    const finalSegments = {}; // "stopA|stopB": [[lon,lat], [lon,lat]]
    let processed = 0;

    for (const segKey of uniqueSegments) {
        const [s1, s2] = segKey.split('|');
        const p1 = validStops.get(s1);
        const p2 = validStops.get(s2);

        if (!p1 || !p2) continue;

        // Pokud je to stejná zastávka (stejné GPS), OSRM nepotřebujeme
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
                    finalSegments[segKey] = [[p1.lon, p1.lat], [p2.lon, p2.lat]]; // Fallback rovná čára
                }
            } else {
                finalSegments[segKey] = [[p1.lon, p1.lat], [p2.lon, p2.lat]]; // Fallback rovná čára
            }
        } catch (e) {
            finalSegments[segKey] = [[p1.lon, p1.lat], [p2.lon, p2.lat]];
        }

        processed++;
        if (processed % 100 === 0) console.log(`   > Vyhlazeno ${processed}/${uniqueSegments.size} segmentů...`);
        
        // ZLATÉ PRAVIDLO: Necháme OSRM vydechnout, aby nás nezařízl (10 požadavků za vteřinu je OK)
        await sleep(100); 
    }

    // --- KROK 7: ULOŽENÍ VÝSLEDKŮ ---
    fs.writeFileSync(path.join(dataDir, 'vdv_segments.json'), JSON.stringify(finalSegments));
    fs.writeFileSync(path.join(dataDir, 'vdv_trips.json'), JSON.stringify(finalTrips));
    
    console.log(`\nHOTOVO! Úspěšně uloženo do data/`);
    console.log(`Velikost tras: ${(fs.statSync(path.join(dataDir, 'vdv_segments.json')).size / 1024).toFixed(1)} KB`);
    console.log(`Velikost spojů: ${(fs.statSync(path.join(dataDir, 'vdv_trips.json')).size / 1024).toFixed(1)} KB`);
}

runSegmentRouting().catch(console.error);
