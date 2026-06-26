import pandas as pd
import requests
import json
import time
import os

BASE_URL = "https://hoermalmeister.github.io/gtfs-rehost/vdv/"
SEGMENTS_FILE = "data/vdv_segments.json"
TRIPS_FILE = "data/vdv_trips.json"

# Ujistíme se, že složka existuje
os.makedirs("data", exist_ok=True)

def run():
    print("1. Stahuji předpřipravená data z gtfs-rehost (Pandas)...")
    routes = pd.read_csv(BASE_URL + "routes.txt")
    trips = pd.read_csv(BASE_URL + "trips.txt")
    stops = pd.read_csv(BASE_URL + "stops.txt", low_memory=False)
    stop_times = pd.read_csv(BASE_URL + "stop_times.txt", dtype={'stop_sequence': int})

    print("2. Čistím a propojuji data...")
    stops = stops.dropna(subset=['stop_lon', 'stop_lat'])
    stops_clean = stops.set_index('stop_id')

    # Vyhledání 6místných CISJR linek a spojů
    routes['cisjr_route'] = routes['relations'].astype(str).str.extract(r'CISJR:(\d{6})')
    route_map = routes.dropna(subset=['cisjr_route']).set_index('route_id')['cisjr_route'].to_dict()
    
    trips['cisjr_route'] = trips['route_id'].map(route_map)
    trips['cisjr_trip_num'] = trips['relations'].astype(str).str.extract(r'CISJR:(\d+)')
    trips = trips.dropna(subset=['cisjr_route', 'cisjr_trip_num'])
    trips['cisjr_full_id'] = trips['cisjr_route'] + "_" + trips['cisjr_trip_num']
    
    trip_map = trips.set_index('trip_id')['cisjr_full_id'].to_dict()

    print("3. Generuji sekvence a unikátní segmenty...")
    stop_times['cisjr_full_id'] = stop_times['trip_id'].map(trip_map)
    st_valid = stop_times.dropna(subset=['cisjr_full_id', 'stop_id']).copy()
    
    # Seřadíme podle spoje a pořadí zastávky
    st_valid.sort_values(by=['cisjr_full_id', 'stop_sequence'], inplace=True)
    
    # Posuneme stop_id o jeden řádek, abychom dostali cíl segmentu (zastávka A -> zastávka B)
    st_valid['next_stop'] = st_valid.groupby('cisjr_full_id')['stop_id'].shift(-1)
    segments_df = st_valid.dropna(subset=['next_stop']).copy()
    
    segments_df['segment_id'] = segments_df['stop_id'].astype(str) + "|" + segments_df['next_stop'].astype(str)

    # Vytvoření seznamu segmentů pro každý spoj (slouží pak frontendu pro poskládání trasy)
    final_trips = segments_df.groupby('cisjr_full_id')['segment_id'].apply(list).to_dict()
    unique_segments = segments_df['segment_id'].unique().tolist()
    
    print(f" > Zpracováno {len(final_trips)} platných VDV spojů.")
    print(f" > K routování je celkem {len(unique_segments)} unikátních úseků.")

    print("4. Načítám historii tras (Inkrementální build)...")
    cache = {}
    if os.path.exists(SEGMENTS_FILE):
        try:
            with open(SEGMENTS_FILE, "r", encoding="utf-8") as f:
                cache = json.load(f)
            print(f" > V paměti nalezeno {len(cache)} již vyhlazených úseků z minula.")
        except Exception:
            print(" > Upozornění: Soubor existuje, ale nešel přečíst. Začínáme od nuly.")

    print("5. Spouštím OSRM Routing...")
    api_calls = 0
    new_segments_count = 0

    for seg_id in unique_segments:
        # ÚROVEŇ 1: Segment už známe z minula
        if seg_id in cache: 
            continue 
            
        s1, s2 = seg_id.split('|')
        
        # ÚROVEŇ 2: Shoda v protisměru (známe B->A, hledáme A->B)
        reverse_seg_id = f"{s2}|{s1}"
        if reverse_seg_id in cache:
            # Vezmeme souřadnice protisměru a otočíme jejich pořadí
            cache[seg_id] = cache[reverse_seg_id][::-1]
            continue

        if s1 not in stops_clean.index or s2 not in stops_clean.index: 
            continue
            
        lon1, lat1 = stops_clean.loc[s1, 'stop_lon'], stops_clean.loc[s1, 'stop_lat']
        lon2, lat2 = stops_clean.loc[s2, 'stop_lon'], stops_clean.loc[s2, 'stop_lat']

        # Ošetření: Stejné body nebo příliš velká vzdálenost (rovná čára)
        if (lon1 == lon2 and lat1 == lat2) or abs(lon1 - lon2) > 0.8 or abs(lat1 - lat2) > 0.8:
            cache[seg_id] = [[lon1, lat1], [lon2, lat2]]
            continue

        api_calls += 1
        new_segments_count += 1
        
        try:
            url = f"http://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2}?overview=full&geometries=geojson"
            res = requests.get(url, timeout=5)
            data = res.json()
            if data.get('code') == 'Ok' and len(data['routes']) > 0:
                cache[seg_id] = data['routes'][0]['geometry']['coordinates']
            else:
                cache[seg_id] = [[lon1, lat1], [lon2, lat2]]
            time.sleep(0.15) # Bezpečné čekání proti BANu
        except Exception:
            cache[seg_id] = [[lon1, lat1], [lon2, lat2]]
            time.sleep(0.5)

        # ÚROVEŇ 3: AUTO-SAVE každých 500 dotazů (Záchrana při timeoutu Githubu)
        if api_calls % 500 == 0:
            print(f"   > Zavoláno {api_calls} nových OSRM dotazů (Ukládám postup...)")
            with open(SEGMENTS_FILE, "w", encoding="utf-8") as f:
                json.dump(cache, f, separators=(',', ':'))

    print("6. Ukládám finální soubory pro Můstek...")
    with open(SEGMENTS_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, separators=(',', ':'))

    with open(TRIPS_FILE, "w", encoding="utf-8") as f:
        json.dump(final_trips, f, separators=(',', ':'))

    print(f"\nHOTOVO! Vyhlazeno {new_segments_count} nových úseků. Skutečných API dotazů: {api_calls}.")

if __name__ == "__main__":
    run()
