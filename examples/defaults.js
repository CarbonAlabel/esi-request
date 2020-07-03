import {ESIRequest} from "../index.js";

// This ESI instance will request German-localized strings.
let ESI = new ESIRequest({
    default_headers: {
        "accept-language": "de"
    }
});

(async () => {
    // Request the list of factions.
    let factions = await ESI.request("/v2/universe/factions/");
    // Find the Amarr Empire.
    let amarr = factions.data.find(faction => faction.faction_id === 500003);
    // Return the description for the Amarr Empire (in German).
    return amarr.description;
})().then(console.log, console.error).finally(ESI.close);
