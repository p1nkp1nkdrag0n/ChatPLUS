const SCENES = ["botanical", "mountain", "forest", "desk", "coast", "night"];

function characterAvatarSrc(characterId: string): string {
  let hash = 0;
  for (const letter of characterId)
    hash = (Math.imul(hash, 31) + letter.charCodeAt(0)) >>> 0;
  return `/dearvale/art/${SCENES[hash % SCENES.length]}.png`;
}

export function CharacterAvatar({
  characterId,
  name = "",
  size = 48,
  className = "",
}: {
  characterId: string;
  name?: string;
  size?: number;
  className?: string;
}) {
  return (
    <img
      className={`character-avatar ${className}`}
      src={characterAvatarSrc(characterId)}
      width={size}
      height={size}
      alt={name}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        objectFit: "cover",
        flexShrink: 0,
      }}
    />
  );
}
