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
