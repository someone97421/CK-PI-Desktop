import mascotUrl from "../assets/brand/logo-dark.png";

export function HomeMascotLogo() {
  return (
    <span
      className="home-mascot-logo"
      data-testid="home-mascot-logo"
      aria-hidden="true"
    >
      <img
        className="home-mascot-dinosaur"
        src={mascotUrl}
        alt=""
        width={100}
        height={100}
        draggable={false}
      />
    </span>
  );
}
