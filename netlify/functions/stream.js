exports.handler = async (event, context) => {
    const playlistUrls = [
        process.env.STREAM_SOURCE_URL, 
        process.env.M3U_SOURCE_TWO,    
        process.env.M3U_SOURCE_THREE   
    ].filter(Boolean); 

    try {
        // Uses the global, built-in fetch API
        const requests = playlistUrls.map(url => 
            fetch(url)
                .then(res => res.ok ? res.text() : '')
                .catch(() => '') 
        );
        
        const playlistsContent = await Promise.all(requests);
        let masterM3U = "#EXTM3U\n";
        
        playlistsContent.forEach(content => {
            const lines = content.split('\n');
            lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#EXTM3U')) {
                    masterM3U += trimmed + "\n";
                }
            });
        });

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "text/plain",
                "Access-Control-Allow-Origin": "*", 
            },
            body: masterM3U
        };

    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed compiling aggregated stream pool profiles." })
        };
    }
};
