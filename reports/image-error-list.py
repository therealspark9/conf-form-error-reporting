import ijson
import pandas as pd
import os

def extract_errors(json_file_path, output_csv_path, search_substring):
    """
    Stream parses a large JSON file, filters URLs containing a substring,
    removes duplicates, and saves to CSV.
    """
    
    # Check if file exists
    if not os.path.exists(json_file_path):
        print(f"Error: The file '{json_file_path}' was not found.")
        return

    print(f"Processing {json_file_path}...")
    print("This may take a moment depending on file size...")

    # We use a list to store only the matching records to save memory
    extracted_data = []
    
    try:
        # Open file in binary mode for ijson
        with open(json_file_path, 'rb') as f:
            # 'item' assumes the JSON structure is a list of objects [{},{}]
            # If your JSON is a dict {"data": [{},{}]}, change 'item' to 'data.item'
            parser = ijson.items(f, 'item')
            
            count = 0
            match_count = 0
            
            for record in parser:
                count += 1
                
                # Get the URL safely
                url = record.get('errorLocation', '')
                
                # Check condition: substring must be in the URL
                if search_substring in url:
                    extracted_data.append({
                        'Error Message': record.get('errorText', 'Unknown Error'),
                        'URL': url
                    })
                    match_count += 1

                # Optional: Print progress every 100k lines to show script is alive
                if count % 100000 == 0:
                    print(f"Scanned {count} records... Found {match_count} matches so far.")

    except Exception as e:
        print(f"An error occurred during parsing: {e}")
        return

    print(f"\nScanning complete.")
    print(f"Total records scanned: {count}")
    print(f"Matches found: {len(extracted_data)}")

    # Convert to DataFrame
    if extracted_data:
        df = pd.DataFrame(extracted_data)

        # Drop duplicate URLs
        # keeping='first' keeps the first occurrence and drops subsequent ones
        initial_len = len(df)
        df.drop_duplicates(subset=['URL'], keep='first', inplace=True)
        print(f"Duplicates removed: {initial_len - len(df)}")

        # Rename columns to match your requested output description implicitly
        # (Column 1: Error, Column 2: URL)
        df.columns = ['Failed to load resource: net::ERR_FAILED', 'URL']

        # Export to CSV
        try:
            df.to_csv(output_csv_path, index=False)
            print(f"SUCCESS: Data exported to '{output_csv_path}'")
        except PermissionError:
            print(f"Error: Could not write to '{output_csv_path}'. Is the file open?")
    else:
        print("No matching records found. No CSV generated.")

# --- CONFIGURATION ---
if __name__ == "__main__":
    # 1. Name of your input JSON file
    INPUT_FILE = "error-report-2025-11-27T01-22-32-509Z.json" 
    
    # 2. Name of your desired output CSV
    OUTPUT_FILE = "filtered_errors.csv"
    
    # 3. The substring to search for
    SEARCH_TEXT = "/content/dam/"

    # Run the function
    extract_errors(INPUT_FILE, OUTPUT_FILE, SEARCH_TEXT)