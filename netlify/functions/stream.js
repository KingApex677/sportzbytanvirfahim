const fetch = require('node-fetch'); // Ensure node-fetch is in your dependencies

exports.handler = async (event, context) => {
    // Array of your M3U API stream endpoints retrieved from environment variables
    const playlistUrls = [
        process.env.STREAM_SOURCE_URL, // Your primary URL
        process.env.M3U_SOURCE_TWO,    // Additional source 2
        process.env.M3U_SOURCE_THREE   // Additional source 3
    ].filter(Boolean); // Filters out any undefined variables safely

    try {
        // Fetch all playlists simultaneously
        const requests = playlistUrls.map(url => 
            fetch(url)
                .then(res => res.ok ? res.text() : '')
                .catch(() => '') // Gracefully skip a source if it goes offline
        );
        
        const playlistsContent = await Promise.all(requests);
        
        // Combine the outputs into one valid master M3U string
        let masterM3U = "#EXTM3U\n";
        
        playlistsContent.forEach(content => {
            // Clean up individual string chunks and split them by line
            const lines = content.split('\n');
            lines.forEach(line => {
                const trimmed = line.trim();
                // Avoid duplicating the main #EXTM3U header tags
                if (trimmed && !trimmed.startsWith('#EXTM3U')) {
                    masterM3U += trimmed + "\n";
                }
            });
        });

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "text/plain",
                "Access-Control-Allow-Origin": "*", // Prevents CORS errors on your player
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
