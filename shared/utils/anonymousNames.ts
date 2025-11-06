/**
 * Generates random anonymous user names like "Blue Tiger", "Silver Snake"
 * similar to Google Docs anonymous users
 */

/**
 * Check if a user ID belongs to an anonymous user
 * @param userId - The user ID to check
 * @returns true if the user ID represents an anonymous user
 */
export function isAnonymousUserId(userId: string | undefined | null): boolean {
    return typeof userId === 'string' && userId.startsWith("anonymous-");
}

const adjectives = [
    "Red",
    "Blue",
    "Green",
    "Purple",
    "Orange",
    "Pink",
    "Yellow",
    "Cyan",
    "Magenta",
    "Violet",
    "Indigo",
    "Turquoise",
    "Gold",
    "Silver",
    "Bronze",
    "Emerald",
    "Ruby",
    "Sapphire",
    "Amber",
    "Jade",
    "Pearl",
    "Coral",
    "Crimson",
    "Azure",
    "Scarlet",
];

const animals = [
    "Tiger",
    "Lion",
    "Eagle",
    "Dolphin",
    "Panther",
    "Wolf",
    "Fox",
    "Bear",
    "Falcon",
    "Hawk",
    "Leopard",
    "Cheetah",
    "Jaguar",
    "Lynx",
    "Puma",
    "Cobra",
    "Python",
    "Viper",
    "Dragon",
    "Phoenix",
    "Raven",
    "Owl",
    "Shark",
    "Whale",
    "Orca",
    "Penguin",
    "Swan",
    "Crane",
    "Heron",
    "Elephant",
    "Rhino",
    "Buffalo",
    "Moose",
    "Deer",
    "Gazelle",
];

const colors = [
    "#e74c3c", // Red
    "#3498db", // Blue
    "#2ecc71", // Green
    "#9b59b6", // Purple
    "#e67e22", // Orange
    "#f368e0", // Pink
    "#f1c40f", // Yellow
    "#00d2d3", // Cyan
    "#c44569", // Magenta
    "#8e44ad", // Violet
    "#5f27cd", // Indigo
    "#1abc9c", // Turquoise
    "#f39c12", // Gold
    "#95a5a6", // Silver
    "#d35400", // Bronze
    "#27ae60", // Emerald
    "#c0392b", // Ruby
    "#2980b9", // Sapphire
    "#f39c12", // Amber
    "#16a085", // Jade
    "#ecf0f1", // Pearl
    "#ff7979", // Coral
    "#eb4d4b", // Crimson
    "#0984e3", // Azure
    "#d63031", // Scarlet
];

/**
 * Generates a deterministic anonymous name based on a seed string
 * @param seed - A unique identifier (like shareId) to ensure consistent names
 * @returns An object with name and color
 */
export function generateAnonymousName(seed: string): {
    name: string;
    color: string;
} {
    // Simple hash function to convert string to number
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        const char = seed.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32bit integer
    }

    // Use absolute value to ensure positive index
    const absHash = Math.abs(hash);

    // Select adjective and animal based on hash
    const adjectiveIndex = absHash % adjectives.length;
    const animalIndex = Math.floor(absHash / adjectives.length) % animals.length;
    const colorIndex = absHash % colors.length;

    const adjective = adjectives[adjectiveIndex];
    const animal = animals[animalIndex];
    const color = colors[colorIndex];

    return {
        name: `${adjective} ${animal}`,
        color,
    };
}
