import fs from 'fs';
import AdmZip from 'adm-zip';

// Pomocná funkce pro čtení CSV
function parseCsvLine(text) {
    let ret = [], current = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        let char = text[i];
        if (char === '"' && text[i+1] === '"') { current += '"'; i++; } 
        else if (char === '"') { inQuotes = !inQuotes; }
        else if (char === ',' && !inQuotes) { ret.push(current.trim()); current = ''; }
        else { current += char; }
    }
    ret.push(current.trim());
    return ret;
}

async function processJMK() {
    console.log("Stahuji GTFS JMK...");
    const res = await fetch('https://kordis-jmk.cz/gtfs/gtfs.zip');
    if (!res.ok) throw new Error("Nelze stáhnout JMK GTFS");
    
    const buffer = await res.arrayBuffer();
    const zip = new AdmZip(Buffer.from(buffer));
    const stopsEntry = zip.getEntries().find(e => e.entryName === 'stops.txt');
    
    const lines = zip.readAsText(stopsEntry, 'utf8').split('\n');
    let firstLine = lines[0].trim();
    if (firstLine.charCodeAt(0) === 0xFEFF) firstLine = firstLine.slice(1);
    
    const headers = parseCsvLine(firstLine);
    const idIdx = headers.findIndex(h => h.includes('stop_id'));
    const nameIdx = headers.findIndex(h => h.includes('stop_name'));
    const typeIdx = headers.findIndex(h => h.includes('location_type'));

    let stopsMap = {};
    for(let i = 1; i < lines.length; i++) {
        if(!lines[i]) continue;
        const cols = parseCsvLine(lines[i].trim());
        const stop_id = cols[idIdx], stop_name = cols[nameIdx];
        const loc_type = typeIdx !== -1 ? cols[typeIdx] : null;

        if(!stop_id || !stop_name) continue;
        const idMatch = stop_id.match(/\d+/);
        if (idMatch) {
            const numericId = idMatch[0];
            if (loc_type === '1' || !stopsMap[numericId]) {
                stopsMap[numericId] = stop_name.replace(/"/g, '');
            }
        }
    }
    fs.writeFileSync('./data/jmk_stops.json', JSON.stringify(stopsMap));
    console.log(`JMK hotovo: ${Object.keys(stopsMap).length} zastávek.`);
}

async function processPID() {
    console.log("Stahuji GTFS PID...");
    const res = await fetch('https://www.spojenka.cz/jrdata/jizdnirady-gtfs.zip');
    if (!res.ok) throw new Error("Nelze stáhnout PID GTFS");
    
    const buffer = await res.arrayBuffer();
    const zip = new AdmZip(Buffer.from(buffer));

    // 1. Zpracování routes.txt (Získání CISJR linky)
    const routesEntry = zip.getEntries().find(e => e.entryName === 'routes.txt');
    const routeLines = zip.readAsText(routesEntry, 'utf8').split('\n');
    let routeHeader = routeLines[0].trim();
    if (routeHeader.charCodeAt(0) === 0xFEFF) routeHeader = routeHeader.slice(1);
    
    const rH = parseCsvLine(routeHeader);
    const rIdIdx = rH.findIndex(h => h.includes('route_id'));
    const rRelIdx = rH.findIndex(h => h.includes('relations'));

    const routeMap = {};
    for (let i = 1; i < routeLines.length; i++) {
        if (!routeLines[i]) continue;
        const cols = parseCsvLine(routeLines[i].trim());
        if (cols[rIdIdx] && cols[rRelIdx]) {
            const match = cols[rRelIdx].match(/CISJR:(\d+)/);
            if (match) routeMap[cols[rIdIdx]] = match[1];
        }
    }

    // 2. Zpracování trips.txt (Párování CISJR spoje s PID identifikátorem z Golemia)
    const tripsEntry = zip.getEntries().find(e => e.entryName === 'trips.txt');
    const tripLines = zip.readAsText(tripsEntry, 'utf8').split('\n');
    let tripHeader = tripLines[0].trim();
    if (tripHeader.charCodeAt(0) === 0xFEFF) tripHeader = tripHeader.slice(1);

    const tH = parseCsvLine(tripHeader);
    const tRIdIdx = tH.findIndex(h => h.includes('route_id'));
    const tRelIdx = tH.findIndex(h => h.includes('relations'));

    const pidTrips = {};
    for (let i = 1; i < tripLines.length; i++) {
        if (!tripLines[i]) continue;
        const cols = parseCsvLine(tripLines[i].trim());
        const rId = cols[tRIdIdx];
        const rel = cols[tRelIdx];

        // Hledáme relace, které mají jak CISJR, tak i PID!
        if (rel && routeMap[rId]) {
            const cisjrMatch = rel.match(/CISJR:(\d+)/);
            const pidMatch = rel.match(/PID:([0-9_]+)/); // Typicky vyškrtne např. 320_609_260420

            if (cisjrMatch && pidMatch) {
                const pidKey = pidMatch[1]; // Toto je to naše tripId z Golemia
                pidTrips[pidKey] = {
                    cisjrLine: routeMap[rId],
                    cisjrTrip: cisjrMatch[1]
                };
            }
        }
    }
    fs.writeFileSync('./data/pid_cisjr.json', JSON.stringify(pidTrips));
    console.log(`PID hotovo: ${Object.keys(pidTrips).length} CISJR spojů uloženo pod PID klíči.`);
}

// Vytvoříme cílovou složku, pokud neexistuje
if (!fs.existsSync('./data')) fs.mkdirSync('./data');

// Spuštění
(async () => {
    await processJMK();
    await processPID();
})();

async function processVdvStopsById() {
    console.log("Stahuji GTFS pro generování tras VDV (ID matching)...");
    const res = await fetch('https://www.spojenka.cz/jrdata/jizdnirady-gtfs.zip');
    if (!res.ok) throw new Error("Nelze stáhnout GTFS ze Spojenky");
    
    const buffer = await res.arrayBuffer();
    const zip = new AdmZip(Buffer.from(buffer));
    
    const parseCsvLine = (line) => {
        const result = []; let current = ''; let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"' && line[i + 1] === '"') { current += '"'; i++; }
            else if (char === '"') { inQuotes = !inQuotes; }
            else if (char === ',' && !inQuotes) { result.push(current); current = ''; }
            else { current += char; }
        }
        result.push(current); return result;
    };

    // 1. Zastávky: stop_id -> {lat, lon}
    const stopsEntry = zip.getEntries().find(e => e.entryName === 'stops.txt');
    const stopsLines = zip.readAsText(stopsEntry, 'utf8').split('\n');
    const sH = parseCsvLine(stopsLines[0].trim());
    const stopMap = {};
    for (let i = 1; i < stopsLines.length; i++) {
        if (!stopsLines[i]) continue;
        const cols = parseCsvLine(stopsLines[i].trim());
        stopMap[cols[sH.indexOf('stop_id')]] = {
            lat: parseFloat(cols[sH.indexOf('stop_lat')]),
            lon: parseFloat(cols[sH.indexOf('stop_lon')])
        };
    }

    // 2. Linky: route_id -> 841129
    const routesEntry = zip.getEntries().find(e => e.entryName === 'routes.txt');
    const routeLines = zip.readAsText(routesEntry, 'utf8').split('\n');
    const rH = parseCsvLine(routeLines[0].trim());
    const routeMap = {};
    for (let i = 1; i < routeLines.length; i++) {
        if (!routeLines[i]) continue;
        const cols = parseCsvLine(routeLines[i].trim());
        const rel = cols[rH.indexOf('relations')];
        if (rel) {
            const match = rel.match(/CISJR:(\d{6})/);
            if (match) routeMap[cols[rH.indexOf('route_id')]] = match[1];
        }
    }

    // 3. Spoje: trip_id -> "841129_25"
    const tripsEntry = zip.getEntries().find(e => e.entryName === 'trips.txt');
    const tripLines = zip.readAsText(tripsEntry, 'utf8').split('\n');
    const tH = parseCsvLine(tripLines[0].trim());
    const tripMap = {}; 
    for (let i = 1; i < tripLines.length; i++) {
        if (!tripLines[i]) continue;
        const cols = parseCsvLine(tripLines[i].trim());
        const rId = cols[tH.indexOf('route_id')];
        const rel = cols[tH.indexOf('relations')];
        
        if (rId && rel && routeMap[rId]) {
            const match = rel.match(/CISJR:(\d+)/);
            if (match) tripMap[cols[tH.indexOf('trip_id')]] = `${routeMap[rId]}_${match[1]}`;
        }
    }

    // 4. Čtení stop_times.txt (řádek po řádku kvůli úspoře RAM)
    console.log("Zpracovávám stop_times.txt pro VDV...");
    const stEntry = zip.getEntries().find(e => e.entryName === 'stop_times.txt');
    const stData = zip.readAsText(stEntry, 'utf8');
    
    const vdvRawStops = {}; 
    let stHeaders = null;
    let tIdx = -1, sIdx = -1, seqIdx = -1;

    let lineStart = 0;
    while (lineStart < stData.length) {
        let lineEnd = stData.indexOf('\n', lineStart);
        if (lineEnd === -1) lineEnd = stData.length;
        const line = stData.slice(lineStart, lineEnd).trim();
        lineStart = lineEnd + 1;

        if (!line) continue;

        if (!stHeaders) {
            stHeaders = parseCsvLine(line);
            tIdx = stHeaders.indexOf('trip_id');
            sIdx = stHeaders.indexOf('stop_id');
            seqIdx = stHeaders.indexOf('stop_sequence');
            continue;
        }

        const firstComma = line.indexOf(',');
        const tId = line.substring(0, firstComma).replace(/"/g, ''); 
        
        const vdvKey = tripMap[tId];
        if (vdvKey) {
            const cols = parseCsvLine(line);
            const stop = stopMap[cols[sIdx]];
            if (stop) {
                if (!vdvRawStops[vdvKey]) vdvRawStops[vdvKey] = [];
                vdvRawStops[vdvKey].push({
                    seq: parseInt(cols[seqIdx], 10),
                    lat: stop.lat,
                    lon: stop.lon
                });
            }
        }
    }

    // 5. Seřazení a uložení
    const vdvFinalStops = {};
    for (const key in vdvRawStops) {
        vdvRawStops[key].sort((a, b) => a.seq - b.seq);
        vdvFinalStops[key] = vdvRawStops[key].map(pt => [pt.lon, pt.lat]); // [lon, lat] pro OSRM
    }

    fs.writeFileSync('./data/vdv_stops_coords.json', JSON.stringify(vdvFinalStops));
    console.log(`Hotovo! Sekvence souřadnic uloženy pro ${Object.keys(vdvFinalStops).length} spojů VDV.`);
}
